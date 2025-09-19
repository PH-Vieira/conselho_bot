import CONFIG from '../lib/config.js';
import { db } from '../lib/db.js';
import logger from '../lib/logger.js';
import helpers, { isYesToken, isNoToken, matchStickerHash, levelFromXp, titleForLevel } from '../lib/helpers.js';
import { ensureUser, recordUserVoteOnce, listUsers } from '../lib/db.js';
import { safePost } from '../lib/messaging.js';
import { nanoid } from 'nanoid';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export default function registerMessageHandlers(sock) {
  // Helper functions to persist short-lived pending selections in DB
  const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
  function cleanupPendingSelections() {
    const now = new Date().toISOString();
    const obj = db.data.pendingSelections || {};
    for (const [k, v] of Object.entries(obj)) {
      if (!v || !v.expiresAtISO || v.expiresAtISO < now) delete obj[k];
    }
    db.data.pendingSelections = obj;
  }
  function setPendingSelection(voterId, list) {
    const expiresAtISO = new Date(Date.now() + PENDING_TTL_MS).toISOString();
    db.data.pendingSelections = db.data.pendingSelections || {};
    db.data.pendingSelections[voterId] = { list, expiresAtISO };
    return db.write();
  }
  function getPendingSelection(voterId) {
    cleanupPendingSelections();
    const obj = db.data.pendingSelections || {};
    const entry = obj[voterId];
    if (!entry || !entry.list) return null;
    return entry.list;
  }
  const handler = async ({ messages }) => {
    for (const msg of messages) {
      logger.debug({ msgKey: msg.key, message: msg.message }, 'messages.upsert received');
      try {
        function unwrapMessage(message) {
          let m = message || {};
          if (m.ephemeralMessage && m.ephemeralMessage.message) m = m.ephemeralMessage.message;
          if (m.viewOnceMessage && m.viewOnceMessage.message) m = m.viewOnceMessage.message;
          // some payloads nest message inside .message (safeguard)
          if (m.message && m.message.ephemeralMessage && m.message.ephemeralMessage.message) m = m.message.ephemeralMessage.message;
          if (m.message && m.message.viewOnceMessage && m.message.viewOnceMessage.message) m = m.message.viewOnceMessage.message;
          return m;
        }

        const m = unwrapMessage(msg.message);
        const remoteJid = msg.key.remoteJid;
        const isGroup = remoteJid?.endsWith('@g.us');
        if (!isGroup) continue;

        let group = null;
        if (CONFIG.groupJid) {
          if (CONFIG.groupJid !== remoteJid) continue;
          try {
            group = await sock.groupMetadata(remoteJid);
          } catch (err) {
            logger.warn({ err, remoteJid }, 'failed to fetch group metadata for configured groupJid');
            continue;
          }
        } else {
          group = await helpers.getGroupByName(sock, CONFIG.groupName);
          if (!group) continue;
          if (group.id !== remoteJid) continue;
        }

        const sender = msg.pushName || jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
        const text = m?.conversation || m?.extendedTextMessage?.text || '';
        const ntext = helpers.normalizeText(text);

        // Persist a user entry when they use any bot command (messages starting with '!')
        try {
          if (text && text.trim().startsWith('!')) {
            const cmdUserId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
            ensureUser(cmdUserId);
            db.data.users[cmdUserId].lastSeenISO = new Date().toISOString();
            // prefer sender pushName, else try group metadata or contacts
            if (!db.data.users[cmdUserId].name || db.data.users[cmdUserId].name === cmdUserId.split('@')[0]) {
              let resolved = sender || null;
              try {
                const part = (group && group.participants) ? (group.participants.find((p) => p.id === cmdUserId) || null) : null;
                resolved = resolved || part?.name || part?.notify || part?.pushname || null;
              } catch (e) {}
              if (!resolved && sock.contacts && sock.contacts[cmdUserId]) {
                const c = sock.contacts[cmdUserId];
                resolved = c.name || c.notify || c.vname || resolved;
              }
              if (resolved) db.data.users[cmdUserId].name = resolved;
            }
            await db.write();
          }
        } catch (e) {
          logger.debug({ e }, 'persist command user failed');
        }

        // 1) Criar pauta: !pauta <título>
        if (ntext.startsWith('!pauta ')) {
          // Support optional time specifiers. Examples:
          //  !pauta Título
          //  !pauta Título | 48h
          //  !pauta Título | 30m
          //  !pauta Título 48
          const rest = text.slice(7).trim();
          if (!rest) {
            await safePost(sock, group.id, '❗ Use: !pauta <título da pauta> [<tempo>]');
            continue;
          }

          // try to split title and optional time token using '|' or ';' or ' - '
          let title = rest;
          let timeToken = null;
          const parts = rest.split(/\||;|\s-\s/).map((s) => s.trim()).filter(Boolean);
          if (parts.length > 1) {
            title = parts.slice(0, -1).join(' | ');
            timeToken = parts[parts.length - 1];
          } else {
            // maybe space-separated trailing token like "Title 48h" or "Title 30m"
            const spaceParts = rest.split(/\s+/);
            const last = spaceParts[spaceParts.length - 1];
            // accept trailing tokens like 30m, 48h, or bracketed [30m] or (30m)
            if (/^\[?\(?\d+(h|m)?\)?\]?$/i.test(last)) {
              timeToken = last;
              title = spaceParts.slice(0, -1).join(' ');
            }
          }

          const id = nanoid(5);
          const openedAtISO = new Date().toISOString();
          let deadlineISO;
          if (timeToken) {
            // strip optional surrounding brackets/parentheses like [30m] or (30m)
            timeToken = timeToken.replace(/^[\[\(]+|[\]\)]+$/g, '');
            // remove trailing punctuation like commas or dots
            timeToken = timeToken.replace(/[.,\s]+$/g, '');
            // accept units: h, hr, hours, m, min, minutes
            const m = timeToken.match(/^(\d+)(h|hr|hours|m|min|minutes)?$/i);
            if (m) {
              const num = Number(m[1]);
              const unitToken = (m[2] || 'h').toLowerCase();
              const isMinutes = ['m', 'min', 'minutes'].includes(unitToken);
              if (isMinutes) {
                deadlineISO = helpers.computeDeadlineFromMinutes(openedAtISO, num);
              } else {
                // treat as hours
                deadlineISO = helpers.computeDeadline(openedAtISO, num);
              }
            } else {
              // fallback to default
              deadlineISO = helpers.computeDeadline(openedAtISO, CONFIG.voteWindowHours || 24);
            }
          } else {
            deadlineISO = helpers.computeDeadline(openedAtISO, CONFIG.voteWindowHours || 24);
          }
          db.data.proposals.push({
            id,
            title,
            openedBy: sender,
            groupJid: group.id,
            openedAtISO,
            deadlineISO,
            votes: {},
            status: 'open',
          });
          await db.write();
          const timeLeft = helpers.humanTimeLeft(deadlineISO);
          const formattedDeadline = helpers.formatToUTCMinus3(deadlineISO);
          await safePost(
            sock,
            group.id,
            `📢 Pauta *${title}* aberta por *${sender}*:\n> ${title}\n⏳ Prazo: ${timeLeft} (até ${formattedDeadline}).\nVote com ✅ / ❌, envie 'sim'/'nao' ou use a figurinha do Conselho para confirmar.`
          );
          continue;
        }

        // 2) Contagem atual: !contagem [id]
        if (ntext.startsWith('!contagem')) {
          const [, rawId] = ntext.split(' ');
          const target = rawId
            ? db.data.proposals.find((p) => p.id === rawId)
            : db.data.proposals.filter((p) => p.status === 'open').slice(-1)[0];
          if (!target) {
            await safePost(sock, group.id, 'ℹ️ Nenhuma pauta encontrada.');
            continue;
          }
          const { yes, no } = helpers.summarizeVotes(target.votes);
          const left = helpers.humanTimeLeft(target.deadlineISO);
          const fmt = helpers.formatToUTCMinus3(target.deadlineISO);
          await safePost(
            sock,
            group.id,
            `📊 Pauta *${target.title}*: ✅ ${yes} | ❌ ${no} • Tempo restante: ${left} (até ${fmt})`
          );
          continue;
        }

        // --- Debug: reabrir a proposal by id: !reabrir <id>
        // Useful to re-send the formatted proposal text without creating a new one.
        if (ntext.startsWith('!reabrir')) {
          const [, rawId] = ntext.split(' ');
          const target = rawId
            ? db.data.proposals.find((p) => p.id === rawId && p.groupJid === group.id)
            : (db.data.proposals || []).filter((p) => p.groupJid === group.id && p.status === 'open').slice(-1)[0];
          if (!target) {
            await safePost(sock, group.id, 'ℹ️ Pauta não encontrada para reannounciar. Use: !reabrir <id>');
            continue;
          }
          const left = helpers.humanTimeLeft(target.deadlineISO);
          const fmt = helpers.formatToUTCMinus3(target.deadlineISO);
          await safePost(sock, group.id, `📢 (re)Pauta *${target.title}* aberta por *${target.openedBy}*:\n> ${target.title}\n⏳ Prazo: ${left} (até ${fmt}).`);
          continue;
        }

        // 3) Listar pautas: !pautas
        if (ntext === '!pautas') {
          const list = (db.data.proposals || [])
            .filter((p) => p.groupJid === group.id)
            .slice(-10)
            .map((p) => {
              const left = helpers.humanTimeLeft(p.deadlineISO);
              const fmt = helpers.formatToUTCMinus3(p.deadlineISO);
              return `${p.title} (${p.status}) — Prazo: ${left} (até ${fmt})`;
            })
            .join('\n');
          await safePost(sock, group.id, list || 'ℹ️ Sem pautas registradas.');
          continue;
        }

        // 4) Ajuda: !help (resumido)
        if (ntext === '!help') {
          const helpMsg = [];
          helpMsg.push('🛠️ Conselho de Pautas — comandos principais:');
          helpMsg.push('');
          helpMsg.push('• !pauta <título> [<tempo>] — criar nova pauta (ex.: !pauta Reunião 48h)');
          helpMsg.push('• !votar <id|nome> [sim|nao] — votar (use !votar <nome> para confirmar antes)');
          helpMsg.push('• Envie "sim"/"nao" ou ✅/❌ — votar na pauta mais recente');
          helpMsg.push('• Envie a figurinha do Conselho — trava seu voto (finaliza)');
          helpMsg.push('');
          helpMsg.push('• !contagem — mostrar votos e prazo da pauta atual');
          helpMsg.push('• !pautas — listar pautas recentes');
          helpMsg.push('• !me — ver seu nível, XP e votos registrados');
          helpMsg.push('• !ranking — ver os maiores votantes (usa JID se nenhum nome salvo)');
          helpMsg.push('• !setnome <seu nome> — definir nome exibido no ranking');
          helpMsg.push('');
          helpMsg.push('Para mais detalhes, consulte o README ou peça ao admin.');

          await safePost(sock, group.id, helpMsg.join('\n'));
          continue;
        }

        // --- Comando: !setnome <nome>
        if (ntext.startsWith('!setnome')) {
          const raw = text.split(/\s+/).slice(1).join(' ').trim();
          const voterId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
          if (!raw) {
            await safePost(sock, group.id, `❗ Uso: !setnome <seu nome> — ex.: !setnome João Silva`);
            continue;
          }
          try {
            ensureUser(voterId);
            db.data.users[voterId].name = raw;
            await db.write();
            await safePost(sock, group.id, `✅ Nome definido: ${raw} (aparecerá no ranking)`);
          } catch (e) {
            logger.error({ e, voterId, raw }, 'failed to set name');
            await safePost(sock, group.id, '❗ Falha ao salvar o nome. Tente novamente.');
          }
          continue;
        }

        // --- Admin: !resync-names (optional) - refreshes names for all users from contacts/group metadata
        if (ntext === '!resync-names') {
          // only allow if adminJid is configured and matches sender
          if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(msg.key.participant || msg.key.remoteJid)) {
            await safePost(sock, group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !resync-names.');
            continue;
          }
          try {
            const users = Object.keys(db.data.users || {});
            let changed = 0;
            for (const u of users) {
              try {
                const norm = jidNormalizedUser(u);
                let resolved = db.data.users[u].name || null;
                // try group participants first
                try {
                  const part = (group && group.participants) ? (group.participants.find((p) => p.id === norm) || null) : null;
                  resolved = resolved || part?.name || part?.notify || part?.pushname || null;
                } catch (e) {}
                // try socket getName or contacts
                try {
                  if (!resolved && typeof sock.getName === 'function') {
                    const n = await sock.getName(norm).catch(() => null);
                    if (n) resolved = n;
                  }
                  if (!resolved && sock.contacts && sock.contacts[norm]) {
                    const c = sock.contacts[norm];
                    resolved = c.name || c.notify || c.vname || resolved;
                  }
                } catch (e) {}
                if (resolved && resolved !== db.data.users[u].name) {
                  db.data.users[u].name = resolved;
                  changed += 1;
                }
              } catch (e) {
                logger.debug({ e, u }, 'resync-names: per-user lookup failed');
              }
            }
            await db.write();
            await safePost(sock, group.id, `✅ Resync concluído. Nomes atualizados: ${changed}. Usuários verificados: ${users.length}.`);
          } catch (e) {
            logger.error({ e }, 'resync-names failed');
            await safePost(sock, group.id, '❗ Falha ao ressincronizar nomes. Veja os logs.');
          }
          continue;
        }

        // --- Perfil: !me
        if (ntext === '!me') {
          const voterId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
          ensureUser(voterId);
          const u = db.data.users[voterId] || { xp: 0, votesCount: 0 };
          const lvl = levelFromXp(u.xp || 0);
          const title = titleForLevel(lvl.level);
          const badge = helpers.badgeForLevel(lvl.level);
          const bar = helpers.progressBar(lvl.xpIntoLevel, lvl.xpForNextLevel, 12);
          const emoji = helpers.pickRandom(helpers.EMOJI_POOLS.confirm);
          const msgText = [];
          msgText.push(`${badge} 👤 ${sender} — *Nível ${lvl.level}* (${title})`);
          msgText.push(`XP: ${u.xp || 0} (${lvl.xpIntoLevel}/${lvl.xpForNextLevel}) ${bar}`);
          msgText.push(`Votos registrados: ${u.votesCount || 0} ${emoji}`);
          await safePost(sock, group.id, msgText.join('\n'));
          continue;
        }

        // --- Ranking: !ranking
        if (ntext === '!ranking') {
          // Build a map of voters by scanning proposals (single source of truth for votes)
          const usersMap = {};
          for (const p of db.data.proposals || []) {
            if (p.groupJid !== group.id) continue;
            for (const voterJid of Object.keys(p.votes || {})) {
              const norm = jidNormalizedUser(voterJid);
              if (!usersMap[norm]) usersMap[norm] = { jid: norm, name: null, xp: 0, votesCount: 0 };
              usersMap[norm].votesCount = (usersMap[norm].votesCount || 0) + 1;
            }
          }

          // Enrich from DB users (xp, name) without changing votesCount computed above
          const dbUsers = listUsers() || {};
          for (const [jid, data] of Object.entries(dbUsers)) {
            const norm = jidNormalizedUser(jid);
            if (!usersMap[norm]) {
              // include users with zero recorded votes? skip to keep ranking to voters only
              continue;
            }
            usersMap[norm].xp = Number(data.xp || 0);
            if (data.name) usersMap[norm].name = data.name;
          }

          // If after scanning we have no users, respond helpfully
          const allRows = Object.values(usersMap || {});
          if (!allRows || allRows.length === 0) { 
            await safePost(sock, group.id, 'ℹ️ Nenhum voto registrado com nome salvo ainda.');
            continue;
          }

          // Enrich name fallback: try DB name, then group metadata, then socket contacts, then JID local part
          const resolvedRows = [];
          for (const r of allRows) {
            let display = r.name || null;
            // try group participants metadata
            try {
              const part = (group && group.participants) ? (group.participants.find((p) => p.id === r.jid) || null) : null;
              if (!display && part) {
                // different Baileys versions use different fields
                display = part?.name || part?.notify || part?.pushname || null;
              }
            } catch (e) {
              // ignore
            }

            // try sock contact lookup if available
            if (!display) {
              try {
                if (typeof sock.getName === 'function') {
                  const n = await sock.getName(r.jid).catch(() => null);
                  if (n) display = n;
                }
                // some environments expose contacts map
                if (!display && sock.contacts && sock.contacts[r.jid]) {
                  const c = sock.contacts[r.jid];
                  display = c.name || c.notify || c.vname || null;
                }
              } catch (e) {
                // ignore
              }
            }

            if (!display) display = r.jid ? r.jid.split('@')[0] : 'Unknown';
            resolvedRows.push({ jid: r.jid, name: display, xp: Number(r.xp || 0), votesCount: Number(r.votesCount || 0) });
          }

          const rows = resolvedRows.sort((a, b) => b.votesCount - a.votesCount || b.xp - a.xp).slice(0, 10);
          const maxXp = Math.max(...rows.map((r) => r.xp || 0), 1);

          const lines = rows.map((row, i) => { 
            const lvl = levelFromXp(row.xp || 0);
            const title = titleForLevel(lvl.level);
            const badge = helpers.badgeForLevel(lvl.level);
            const bar = helpers.progressBar(lvl.xpIntoLevel, lvl.xpForNextLevel, 12);
            const pct = Math.round(((row.xp || 0) / maxXp) * 100);
            const firstLine = `${i + 1}) ${badge} ${row.name} ✨`;
            const voteIcons = row.votesCount >= 3 ? '✅🏆' : row.votesCount === 2 ? '✅🚀' : '👍🚀';
            const secondLine = `   Votos: ${row.votesCount} ${voteIcons} • Nível ${lvl.level} (${title}) • XP: ${row.xp} ${bar}`;
            return `${firstLine}\n${secondLine}`;
          });

          await safePost(sock, group.id, `🏆 Ranking de Participação:\n${lines.join('\n\n')}`);
          continue;
        }

        // ===== Novo: Comando !votar <id|nome> [sim|nao] =====
        if (ntext.startsWith('!votar')) {
          // Use original text to preserve case for ids; normalized ntext is only for command detection
          const rawParts = text.split(/\s+/).filter(Boolean);
          let idOrName = rawParts[1]; // Extract id or name from command
          let answer = rawParts[2];
          // If user attached the answer to the name like 'teste[sim]' or 'teste(sim)', split it
          if (!answer && idOrName) {
            const m = idOrName.match(/^(.+?)[\[\(\s]*([^)\]]+)[\)\]]?$/);
            // m[1] = name, m[2] = answer when pattern matches
            if (m && m[2] && !/^[0-9a-f]{5,}$/i.test(idOrName)) {
              idOrName = m[1];
              answer = m[2];
            }
          }
          // sanitize idOrName by removing surrounding quotes and stray punctuation
          if (idOrName) idOrName = idOrName.replace(/^["'`\s]+|["'`,\.\s]+$/g, '');
          if (!idOrName) {
            await safePost(sock, group.id, '❗ Use: !votar <id|nome> [sim|nao] — ex.: !votar abc12 sim ou !votar Reunião nao');
            continue;
          }
          logger.debug({ rawParts, idOrName, answer }, '!votar parsing');
          // try by id first (preserve case)
          const targetById = (db.data.proposals || []).find((p) => p.id === idOrName && p.groupJid === group.id);
          let target = targetById;
          const voterId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
          // support '!votar last' to vote on most recent open
          if (!target && helpers.normalizeText(idOrName) === 'last' || helpers.normalizeText(idOrName) === 'ultimo') {
            target = (db.data.proposals || []).filter((p) => p.groupJid === group.id && p.status === 'open').slice(-1)[0];
          }
          // If user sent a pure number, try to resolve it against a pending selection list for this user
          if (!target && /^[0-9]+$/.test(idOrName)) {
            const list = getPendingSelection(voterId) || [];
            const idx = Number(idOrName) - 1;
            if (list[idx]) {
              target = db.data.proposals.find((p) => p.id === list[idx] && p.groupJid === group.id);
            }
          }
          // if not found by id, try matching by pauta name (case-insensitive)
          if (!target) {
            const q = helpers.normalizeText(idOrName || '');
            const matches = (db.data.proposals || []).filter((p) => p.groupJid === group.id && helpers.normalizeText(p.title) === q);
            if (matches.length === 1) target = matches[0];
            else if (matches.length > 1) {
              // multiple exact-title matches (rare) — present choices as numbered list
              const choices = matches.slice(0, 8);
              const listText = choices
                .map((c, i) => `${i + 1}) ${c.title.length > 60 ? c.title.slice(0, 57) + '...' : c.title} (${c.status})`)
                .join('\n');
              await safePost(sock, group.id, `ℹ️ Várias pautas correspondem ao nome '${idOrName}'. Responda com '!votar <n>' onde <n> é o número abaixo:\n${listText}`);
              // store pending selection mapping for this user (by id)
              await setPendingSelection(voterId, choices.map((c) => c.id));
              continue;
            } else {
              // try fuzzy includes
              const includes = (db.data.proposals || []).filter((p) => p.groupJid === group.id && helpers.normalizeText(p.title).includes(q));
              if (includes.length === 1) target = includes[0];
              else if (includes.length > 1) {
                const choices = includes.slice(0, 8);
                const listText = choices
                  .map((c, i) => `${i + 1}) ${c.title.length > 60 ? c.title.slice(0, 57) + '...' : c.title} (${c.status})`)
                  .join('\n');
                await safePost(sock, group.id, `ℹ️ Várias pautas contêm '${idOrName}'. Responda com '!votar <n>' onde <n> é o número abaixo:\n${listText}`);
                await setPendingSelection(voterId, choices.map((c) => c.id));
                continue;
              }
            }
          }
          if (!target) {
            logger.info({ idOrName, groupId: group.id }, '!votar: no matching target found');
            await safePost(sock, group.id, `ℹ️ Pauta '${idOrName}' não encontrada neste grupo.`);
            continue;
          }
          logger.debug({ targetId: target.id, targetTitle: target.title }, '!votar matched target');
          const existing = target.votes[voterId];
          const isFinal = existing && typeof existing !== 'string' ? !!existing.final : false;

          if (!answer) {
            // No explicit answer: just acknowledge the target (no change if final)
              if (isFinal) {
              await safePost(sock, group.id, `🔒 ${sender}, seu voto na pauta ${target.title} já está travado.`);
            } else {
              await safePost(sock, group.id, `ℹ️ ${sender}, você está votando na pauta ${target.title}. Envie '!votar "${target.title}" sim' ou '!votar "${target.title}" nao' para confirmar.`);
            }
            continue;
          }

          // strip surrounding brackets or quotes like [sim] or 'sim' or "sim"
          if (answer) answer = String(answer).replace(/^[\[\('"\)\s]+|[\]\)"'\s]+$/g, '');
              if (isYesToken(answer)) {
            if (isFinal) {
              await safePost(sock, group.id, `🔒 ${sender}, seu voto já está travado e não pode ser alterado.`);
              } else {
              target.votes[voterId] = { vote: 'yes', final: false };
              await db.write();
              // award XP once per proposal
              try {
                const xp = helpers.xpForProposal(target.openedAtISO, target.deadlineISO, CONFIG.xpPerVote || 10);
                const res = await recordUserVoteOnce(voterId, target.id, xp);
                  // Persist the voter's current display name into the DB so ranking can show names
                  try {
                    ensureUser(voterId);
                    // prefer explicit sender, else try to resolve from group metadata or contacts
                    let resolvedName = sender || null;
                    if (!resolvedName) {
                      const part = (group && group.participants) ? (group.participants.find((p) => p.id === voterId) || null) : null;
                      resolvedName = part?.name || part?.notify || part?.pushname || null;
                    }
                    if (!resolvedName && sock.contacts && sock.contacts[voterId]) {
                      const c = sock.contacts[voterId];
                      resolvedName = c.name || c.notify || c.vname || null;
                    }
                    if (resolvedName) db.data.users[voterId].name = resolvedName;
                    await db.write();
                  } catch (e) {
                    logger.debug({ e, voterId, sender }, 'failed to persist voter name');
                  }
                if (res.awarded && res.newLevel > res.oldLevel) {
                  const em = helpers.pickRandom(helpers.EMOJI_POOLS.levelUp);
                  // send detailed level-up in DM and a short hint in the group
                  try {
                    await safePost(sock, voterId, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                    await safePost(sock, group.id, `${em} ${sender}, confira sua DM.`);
                  } catch (e) {
                    // fallback: if DM fails, still try to notify in group
                    await safePost(sock, group.id, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                  }
                }
              } catch (e) {
                logger.debug({ e, voterId, targetId: target.id }, 'award xp failed');
              }
              // short group hint and detailed private confirmation
              await safePost(sock, group.id, `✅ ${sender}, seu voto foi registrado — confira sua DM.`);
              try {
                await safePost(sock, voterId, `✅ Seu voto foi salvo: *SIM* na pauta ${target.title}.`);
              } catch (e) {
                logger.debug({ e, voterId }, 'private confirmation failed');
              }
            }
          } else if (isNoToken(answer)) {
            if (isFinal) {
              await safePost(sock, group.id, `🔒 ${sender}, seu voto já está travado e não pode ser alterado.`);
              } else {
              target.votes[voterId] = { vote: 'no', final: false };
              await db.write();
              // award XP once per proposal
              try {
                const xp = helpers.xpForProposal(target.openedAtISO, target.deadlineISO, CONFIG.xpPerVote || 10);
                const res = await recordUserVoteOnce(voterId, target.id, xp);
                  try {
                    ensureUser(voterId);
                    let resolvedName = sender || null;
                    if (!resolvedName) {
                      const part = (group && group.participants) ? (group.participants.find((p) => p.id === voterId) || null) : null;
                      resolvedName = part?.name || part?.notify || part?.pushname || null;
                    }
                    if (!resolvedName && sock.contacts && sock.contacts[voterId]) {
                      const c = sock.contacts[voterId];
                      resolvedName = c.name || c.notify || c.vname || null;
                    }
                    if (resolvedName) db.data.users[voterId].name = resolvedName;
                    await db.write();
                  } catch (e) {
                    logger.debug({ e, voterId, sender }, 'failed to persist voter name');
                  }
                if (res.awarded && res.newLevel > res.oldLevel) {
                  const em = helpers.pickRandom(helpers.EMOJI_POOLS.levelUp);
                  try {
                    await safePost(sock, voterId, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                    await safePost(sock, group.id, `${em} ${sender}, confira sua DM.`);
                  } catch (e) {
                    await safePost(sock, group.id, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                  }
                }
              } catch (e) {
                logger.debug({ e, voterId, targetId: target.id }, 'award xp failed');
              }
              // short group hint and detailed private confirmation
              await safePost(sock, group.id, `❌ ${sender}, seu voto foi registrado — confira sua DM.`);
              try {
                await safePost(sock, voterId, `❌ Seu voto foi salvo: *NÃO* na pauta ${target.title}.`);
              } catch (e) {
                logger.debug({ e, voterId }, 'private confirmation failed');
              }
            }
          } else {
            await safePost(sock, group.id, `❗ Resposta inválida. Use 'sim' ou 'nao' (ex.: !votar "${target.title}" sim).`);
          }
          continue;
        }

        // ===== Comando: !stickerhash (responda a uma figurinha ou envie junto) =====
        if (ntext === '!stickerhash' || ntext === '!hash') {
          // Try several common shapes for quoted/attached stickers
          const ctx = m?.extendedTextMessage?.contextInfo || m?.contextInfo || {};
          const quotedMsg = ctx?.quotedMessage || ctx?.quoted || ctx?.quotedMessage?.stickerMessage;
          // Cases:
          // - reply to sticker: extendedTextMessage.contextInfo.quotedMessage.stickerMessage
          // - sticker sent together with text: m.stickerMessage
          // - some versions wrap quoted differently; inspect several paths
          const tryPaths = [
            m?.extendedTextMessage?.contextInfo?.quotedMessage?.stickerMessage,
            m?.extendedTextMessage?.contextInfo?.quotedMessage,
            m?.contextInfo?.quotedMessage?.stickerMessage,
            m?.stickerMessage,
            m?.message?.stickerMessage,
          ];
          let stickerMsg = null;
          for (const p of tryPaths) {
            if (p && (p.fileSha256 || p.fileSha256?.length)) {
              stickerMsg = p;
              break;
            }
            if (p && p.stickerMessage && (p.stickerMessage.fileSha256 || p.stickerMessage.fileSha256?.length)) {
              stickerMsg = p.stickerMessage;
              break;
            }
          }

          if (!stickerMsg) {
            // nothing obvious found — give a helpful diagnostic to the group and log the message
            await safePost(sock, group.id, "❗ Não encontrei a figurinha — responda a uma figurinha com '!stickerhash' ou envie a figurinha junto com o comando. Se continuar, veja os logs (vou registrar um debug).");
            logger.debug({ message: m, ctx }, 'stickerhash: no sticker payload found');
            continue;
          }

          const md5 = stickerMsg.fileSha256 ? stickerMsg.fileSha256.toString('hex') : null;
          if (!md5) {
            await safePost(sock, group.id, '❗ Não foi possível ler o hash da figurinha (falta fileSha256). Verifique os logs para o objeto da mensagem.');
            logger.debug({ stickerMsg, message: m }, 'stickerhash: sticker present but missing fileSha256');
            continue;
          }

          await safePost(sock, group.id, `🔢 Sticker MD5: ${md5}\nUse este hash em 'lib/helpers.js' para identificar a figurinha do Conselho.`);
          logger.info({ stickerMD5: md5, by: sender }, 'Sticker hash requested');
          continue;
        }

        // ===== Votos por TEXTO/EMOJI (compatibilidade: sem id, aplica para pauta mais recente) =====
        if (text) {
          const target = (db.data.proposals || []).filter((p) => p.groupJid === group.id && p.status === 'open').slice(-1)[0];
          if (target) {
            const voterId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
            const existing = target.votes[voterId];
            const isFinal = existing && typeof existing !== 'string' ? !!existing.final : false;

            if (isYesToken(text)) {
              if (isFinal) {
                await safePost(sock, group.id, `🔒 ${sender}, seu voto já está travado e não pode ser alterado.`);
              } else {
                target.votes[voterId] = { vote: 'yes', final: false };
                await db.write();
                try {
                  const xp = helpers.xpForProposal(target.openedAtISO, target.deadlineISO, CONFIG.xpPerVote || 10);
                  const res = await recordUserVoteOnce(voterId, target.id, xp);
                  try {
                    ensureUser(voterId);
                    let resolvedName = sender || null;
                    if (!resolvedName) {
                      const part = (group && group.participants) ? (group.participants.find((p) => p.id === voterId) || null) : null;
                      resolvedName = part?.name || part?.notify || part?.pushname || null;
                    }
                    if (!resolvedName && sock.contacts && sock.contacts[voterId]) {
                      const c = sock.contacts[voterId];
                      resolvedName = c.name || c.notify || c.vname || null;
                    }
                    if (resolvedName) db.data.users[voterId].name = resolvedName;
                    await db.write();
                  } catch (e) {
                    logger.debug({ e, voterId, sender }, 'failed to persist voter name');
                  }
                    if (res.awarded && res.newLevel > res.oldLevel) {
                      const em = helpers.pickRandom(helpers.EMOJI_POOLS.levelUp);
                      try {
                        await safePost(sock, voterId, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                        await safePost(sock, group.id, `${em} ${sender}, confira sua DM.`);
                      } catch (e) {
                        await safePost(sock, group.id, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                      }
                    }
                } catch (e) {
                  logger.debug({ e, voterId, targetId: target.id }, 'award xp failed');
                }
                await safePost(sock, group.id, `✅ ${sender}, seu voto foi registrado — confira sua DM.`);
                try {
                  await safePost(sock, voterId, `✅ Seu voto foi salvo: *SIM* na pauta ${target.title}.`);
                } catch (e) {
                  logger.debug({ e, voterId }, 'private confirmation failed');
                }
              }
            } else if (isNoToken(text)) {
              if (isFinal) {
                await safePost(sock, group.id, `🔒 ${sender}, seu voto já está travado e não pode ser alterado.`);
              } else {
                target.votes[voterId] = { vote: 'no', final: false };
                await db.write();
                try {
                  const xp = helpers.xpForProposal(target.openedAtISO, target.deadlineISO, CONFIG.xpPerVote || 10);
                  const res = await recordUserVoteOnce(voterId, target.id, xp);
                    if (res.awarded && res.newLevel > res.oldLevel) {
                      const em = helpers.pickRandom(helpers.EMOJI_POOLS.levelUp);
                      try {
                        await safePost(sock, voterId, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                        await safePost(sock, group.id, `${em} ${sender}, confira sua DM.`);
                      } catch (e) {
                        await safePost(sock, group.id, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                      }
                    }
                } catch (e) {
                  logger.debug({ e, voterId, targetId: target.id }, 'award xp failed');
                }
                await safePost(sock, group.id, `❌ ${sender}, seu voto foi registrado — confira sua DM.`);
                try {
                  await safePost(sock, voterId, `❌ Seu voto foi salvo: *NÃO* na pauta ${target.title}.`);
                } catch (e) {
                  logger.debug({ e, voterId }, 'private confirmation failed');
                }
              }
            }
          }
        }

        // ===== Votos por STICKER =====
        const sticker = m?.stickerMessage;
        if (sticker) {
          const md5 = sticker.fileSha256?.toString('hex');
          logger.info({ stickerMD5: md5 }, 'Sticker recebida');
          const match = matchStickerHash(md5);
          if (match) {
            const target = (db.data.proposals || []).filter((p) => p.groupJid === group.id && p.status === 'open').slice(-1)[0];
            if (target) {
              const voterId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
              const existing = target.votes[voterId];
              const isFinal = existing && typeof existing !== 'string' ? !!existing.final : false;

              if (match === 'council') {
                // New behavior: the council sticker finalizes the user's last vote.
                // If the user hasn't voted yet, record a YES and mark it final.
                const prior = existing && typeof existing !== 'string' ? existing.vote : existing;
                if (!prior) {
                  // No prior vote: default to YES and mark final
                    target.votes[voterId] = { vote: 'yes', final: true };
                    await db.write();
                    try {
                      const xp = helpers.xpForProposal(target.openedAtISO, target.deadlineISO, CONFIG.xpPerVote || 10);
                      const res = await recordUserVoteOnce(voterId, target.id, xp);
                      try {
                        ensureUser(voterId);
                        let resolvedName = sender || null;
                        if (!resolvedName) {
                          const part = (group && group.participants) ? (group.participants.find((p) => p.id === voterId) || null) : null;
                          resolvedName = part?.name || part?.notify || part?.pushname || null;
                        }
                        if (!resolvedName && sock.contacts && sock.contacts[voterId]) {
                          const c = sock.contacts[voterId];
                          resolvedName = c.name || c.notify || c.vname || null;
                        }
                        if (resolvedName) db.data.users[voterId].name = resolvedName;
                        await db.write();
                      } catch (e) {
                        logger.debug({ e, voterId, sender }, 'failed to persist voter name');
                      }
                      if (res.awarded && res.newLevel > res.oldLevel) {
                        const em = helpers.pickRandom(helpers.EMOJI_POOLS.levelUp);
                        try {
                          await safePost(sock, voterId, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                          await safePost(sock, group.id, `${em} ${sender}, confira sua DM.`);
                        } catch (e) {
                          await safePost(sock, group.id, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                        }
                      }
                    } catch (e) {
                      logger.debug({ e, voterId, targetId: target.id }, 'award xp failed');
                    }
                    // hint in group, detailed in DM
                    await safePost(sock, group.id, `🛡️ ${sender}, seu voto foi registrado e travado — confira sua DM.`);
                    try {
                      await safePost(sock, voterId, `🛡️ Você não tinha voto anterior; registrei *SIM* e travei seu voto na pauta ${target.title}.`);
                    } catch (e) {
                      logger.debug({ e, voterId }, 'private confirmation failed');
                    }
                } else {
                  // Prior vote exists: mark it final
                  target.votes[voterId] = { vote: prior, final: true };
                  await db.write();
                  // Already voted previously, XP should have been awarded on initial vote; ensure user exists
                  try {
                    ensureUser(voterId);
                  } catch (e) {
                    logger.debug({ e, voterId }, 'ensure user failed');
                  }
                  await safePost(sock, group.id, `🛡️ ${sender}, seu voto foi travado — confira sua DM.`);
                  try {
                    await safePost(sock, voterId, `🛡️ Seu voto foi travado na pauta ${target.title}: *${prior === 'yes' ? 'SIM' : 'NÃO'}*.`);
                  } catch (e) {
                    logger.debug({ e, voterId }, 'private confirmation failed');
                  }
                }
              } else {
                if (isFinal) {
                  await safePost(sock, group.id, `🔒 ${sender}, seu voto já está travado e não pode ser alterado.`);
                } else {
                  target.votes[voterId] = { vote: match, final: false };
                  await db.write();
                      try {
                        const xp = helpers.xpForProposal(target.openedAtISO, target.deadlineISO, CONFIG.xpPerVote || 10);
                        const res = await recordUserVoteOnce(voterId, target.id, xp);
                          try {
                            ensureUser(voterId);
                            let resolvedName = sender || null;
                            if (!resolvedName) {
                              const part = (group && group.participants) ? (group.participants.find((p) => p.id === voterId) || null) : null;
                              resolvedName = part?.name || part?.notify || part?.pushname || null;
                            }
                            if (!resolvedName && sock.contacts && sock.contacts[voterId]) {
                              const c = sock.contacts[voterId];
                              resolvedName = c.name || c.notify || c.vname || null;
                            }
                            if (resolvedName) db.data.users[voterId].name = resolvedName;
                            await db.write();
                          } catch (e) {
                            logger.debug({ e, voterId, sender }, 'failed to persist voter name');
                          }
                        if (res.awarded && res.newLevel > res.oldLevel) {
                          const em = helpers.pickRandom(helpers.EMOJI_POOLS.levelUp);
                          try {
                            await safePost(sock, voterId, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                            await safePost(sock, group.id, `${em} ${sender}, confira sua DM.`);
                          } catch (e) {
                            await safePost(sock, group.id, `${em} Parabéns ${sender}! Você subiu para o nível ${res.newLevel} (XP: ${res.newXp})`);
                          }
                        }
                      } catch (e) {
                        logger.debug({ e, voterId, targetId: target.id }, 'award xp failed');
                      }
                  // concise group hint and DM confirmation
                  await safePost(sock, group.id, `${match === 'yes' ? '✅' : '❌'} ${sender}, seu voto foi registrado — confira sua DM.`);
                  try {
                    await safePost(sock, voterId, `${match === 'yes' ? '✅' : '❌'} Seu voto foi salvo: *${match === 'yes' ? 'SIM' : 'NÃO'}* na pauta ${target.title}.`);
                  } catch (e) {
                    logger.debug({ e, voterId }, 'private confirmation failed');
                  }
                }
              }
            }
          }
        }
      } catch (err) {
        logger.error({ err }, 'Erro ao processar mensagem');
      }
    }
  };

  sock.ev.on('messages.upsert', handler);

  // return unregister function so caller can remove listener when socket is closed
  return () => {
    try {
      sock.ev.off('messages.upsert', handler);
    } catch (e) {
      logger.warn({ e }, 'failed to unregister message handler');
    }
  };
}
