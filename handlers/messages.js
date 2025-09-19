import CONFIG from '../lib/config.js';
import { db } from '../lib/db.js';
import logger from '../lib/logger.js';
import helpers, { isYesToken, isNoToken, matchStickerHash, levelFromXp, titleForLevel } from '../lib/helpers.js';
import { ensureUser, recordUserVoteOnce, listUsers } from '../lib/db.js';
import userUtils from '../lib/userUtils.js';
import fs from 'fs';
const fsp = fs.promises;
import { safePost as importedSafePost } from '../lib/messaging.js';
import { nanoid } from 'nanoid';
// Command modules
import pautaCmd from './commands/pauta.js';
import meCmd from './commands/me.js';
import rankingCmd from './commands/ranking.js';
import setnomeCmd from './commands/setnome.js';
import helpCmd from './commands/help.js';
import dumpUsersCmd from './commands/dump-users.js';
import resyncNamesCmd from './commands/resync-names.js';
import fetchContactsCmd from './commands/fetch-contacts.js';
import dedupeUsersCmd from './commands/dedupe-users.js';
// more command modules can be added here
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export default function registerMessageHandlers(sock) {
  // Helper functions to persist short-lived pending selections in DB
  const PENDING_TTL_MS = 10 * 60 * 1000; // 10 minutes
  /**
   * Remove expired pending selection entries from `db.data.pendingSelections`.
   * Entries are lightweight mappings used to present a short list of choices
   * (for example when multiple proposals match a fuzzy `!votar` query).
   * This function mutates `db.data.pendingSelections` in-memory and does not
   * write to disk; callers should call `db.write()` if persistent changes are
   * required after updates elsewhere.
   */
  function cleanupPendingSelections() {
    const now = new Date().toISOString();
    const obj = db.data.pendingSelections || {};
    for (const [k, v] of Object.entries(obj)) {
      if (!v || !v.expiresAtISO || v.expiresAtISO < now) delete obj[k];
    }
    db.data.pendingSelections = obj;
  }
  /**
   * Store a temporary selection list for `voterId` that expires after
   * `PENDING_TTL_MS`. The stored object includes `list` (array of proposal ids)
   * and an `expiresAtISO` timestamp. Returns the promise from `db.write()`.
   */
  function setPendingSelection(voterId, list) {
    const expiresAtISO = new Date(Date.now() + PENDING_TTL_MS).toISOString();
    db.data.pendingSelections = db.data.pendingSelections || {};
    db.data.pendingSelections[voterId] = { list, expiresAtISO };
    return db.write();
  }
  /**
   * Retrieve the active pending selection list for `voterId` or `null` if
   * none exists or the entry expired. Calling this will first cleanup expired
   * entries.
   */
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
        /**
         * Normalize/unwrap incoming message envelopes.
         * Baileys may wrap actual content inside `ephemeralMessage` or
         * `viewOnceMessage` envelopes (and occasionally nested `.message`),
         * so this helper returns the innermost payload the handlers expect to
         * inspect (text, stickerMessage, etc.).
         */
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
        let group = null;
        const isDm = !isGroup;
        /**
         * Ensure `group` is populated with the configured group metadata.
         * This is used when a command is invoked via DM but needs group
         * context (for example `!ranking` or `!votar`). Returns `true` when
         * `group` is available and `false` otherwise.
         */
        async function requireGroupContext() {
          if (group && group.id && group.id.endsWith('@g.us')) return true;
          if (CONFIG.groupJid) {
            try {
              group = await sock.groupMetadata(CONFIG.groupJid);
              return true;
            } catch (e) {
              logger.warn({ e, cfgGroup: CONFIG.groupJid }, 'requireGroupContext: failed to fetch configured group metadata');
              return false;
            }
          }
          return false;
        }

        if (isGroup) {
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
        } else {
          // Private chat (DM) — create a minimal placeholder so handlers can reply using group.id
          const privateId = msg.key.remoteJid || jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
          group = { id: privateId, participants: [] };
        }

        const sender = msg.pushName || jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
        const dmReplyTo = msg.key.remoteJid || jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
        /**
         * Convenience helper for command handlers to reply to the correct
         * destination. If the incoming message was a DM, replies go back to
         * the DM sender; otherwise replies go to the `targetId` (usually the
         * group id).
         */
        function sendReply(targetId, text) {
          const to = isDm ? dmReplyTo : targetId;
          return safePost(sock, to, text);
        }

        /**
         * Local wrapper around the imported `safePost` sender which rewrites
         * calls that would otherwise target the group to instead target the
         * DM when the original message was a private chat. This preserves
         * backward compatibility with existing code that calls
         * `safePost(sock, group.id, ...)` while enabling DM-friendly
         * responses. The wrapper delegates to the aliased imported function
         * `_origSafePost` to avoid accidental recursion.
         */
        const _origSafePost = importedSafePost;
        function safePost(sockArg, to, text) {
          const toId = (isDm && to === group.id) ? dmReplyTo : to;
          return _origSafePost(sockArg, toId, text);
        }
        const text = m?.conversation || m?.extendedTextMessage?.text || '';
        const ntext = helpers.normalizeText(text);

  /**
   * Persist any group sender into the DB so ranking and other features
   * have a user entry even if the participant never used a bot command.
   * This block runs for messages coming from the configured group (or
   * the matched group) and updates `lastSeenISO` plus attempts to
   * resolve and persist a display name via `userUtils`.
   */
        try {
          if (isGroup) {
            // determine sender JID (participant in groups, or remoteJid for legacy)
            const senderJid = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
            // ignore messages coming from the bot itself (some versions expose sock.user)
            const botJid = (sock && (sock.user?.id || sock.user?.jid)) ? jidNormalizedUser(sock.user.id || sock.user.jid) : null;
            if (senderJid && senderJid !== botJid) {
              ensureUser(senderJid);
              db.data.users[senderJid].lastSeenISO = new Date().toISOString();
              try {
                await userUtils.resolveAndPersistName(sock, group, senderJid, msg.pushName || null);
              } catch (e) {
                logger.debug({ e, senderJid }, 'resolveAndPersistName failed while persisting group sender');
              }
            }
          }
        } catch (e) {
          logger.debug({ e }, 'persist group sender failed');
        }

        // Persist a user entry when they use any bot command (messages starting with '!')
        try {
          if (text && text.trim().startsWith('!')) {
            const cmdUserId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
            ensureUser(cmdUserId);
            db.data.users[cmdUserId].lastSeenISO = new Date().toISOString();
            // try to resolve + persist name via helper
            try {
              await userUtils.resolveAndPersistName(sock, group, cmdUserId, sender);
            } catch (e) {
              logger.debug({ e, cmdUserId }, 'resolveAndPersistName failed on command persist');
            }
          }
        } catch (e) {
          logger.debug({ e }, 'persist command user failed');
        }

  // Command dispatch
  // First, try per-command handlers (modules under handlers/commands).
  // Each handler receives a `cmdCtx` object and should return `true`
  // when it handled the message (to short-circuit further processing).
  // This keeps the legacy inline handlers as a fallback but allows
  // cleaner separation of command logic.
        const cmdCtx = { msg, m, text, ntext, isGroup, isDm, group, sock, db, logger, helpers, CONFIG, sender, sendReply, ensureUser, recordUserVoteOnce, listUsers, userUtils, jidNormalizedUser, nanoid, levelFromXp, titleForLevel };
        const commandHandlers = [
          pautaCmd,
          meCmd,
          rankingCmd,
          setnomeCmd,
          helpCmd,
          dumpUsersCmd,
          resyncNamesCmd,
          fetchContactsCmd,
          dedupeUsersCmd,
        ];
        let handledAny = false;
        for (const h of commandHandlers) {
          try {
            const handled = await h(cmdCtx);
            if (handled) { handledAny = true; break; }
          } catch (e) {
            logger.debug({ e }, 'command handler error');
          }
        }
        if (handledAny) continue;

        // Command handled by modular handlers (pauta)
        // ...legacy inline implementation removed; see handlers/commands/pauta.js

        // --- Debug: reabrir a proposal by id: !reabrir <id>
        // Useful to re-send the formatted proposal text without creating a new one.
        if (ntext.startsWith('!reabrir')) {
            if (isDm) {
              const ok = await requireGroupContext();
              if (!ok) { await sendReply(group.id, 'ℹ️ Este comando precisa do contexto do grupo.'); continue; }
            }
          const [, rawId] = ntext.split(' ');
          const target = rawId
            ? db.data.proposals.find((p) => p.id === rawId && p.groupJid === group.id)
            : (db.data.proposals || []).filter((p) => p.groupJid === group.id && p.status === 'open').slice(-1)[0];
          if (!target) {
            await sendReply(group.id, 'ℹ️ Pauta não encontrada para reannounciar. Use: !reabrir <id>');
            continue;
          }
          const left = helpers.humanTimeLeft(target.deadlineISO);
          const fmt = helpers.formatToUTCMinus3(target.deadlineISO);
          await sendReply(group.id, `📢 (re)Pauta *${target.title}* aberta por *${target.openedBy}*:\n> ${target.title}\n⏳ Prazo: ${left} (até ${fmt}).`);
          continue;
        }

        // Command handled by modular handlers (pautas)

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
          helpMsg.push('• !ranking — ver os maiores votantes (usa JID se nenhum nome salvo) — funciona em grupo ou via DM se `groupJid` estiver configurado');
          helpMsg.push('• !setnome <seu nome> — definir nome exibido no ranking (funciona em DM)');

          await sendReply(group.id, helpMsg.join('\n'));
          continue;
        }

        // --- Comando: !setnome <nome>
        if (ntext.startsWith('!setnome')) {
          const raw = text.split(/\s+/).slice(1).join(' ').trim();
          const voterId = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
          if (!raw) {
            await sendReply(group.id, `❗ Uso: !setnome <seu nome> — ex.: !setnome João Silva`);
            continue;
          }
          try {
            await db.read();
            ensureUser(voterId);
            const prev = db.data.users[voterId].name || null;
            db.data.users[voterId].name = raw;
            await db.write();
            if (prev && prev !== raw) {
              await sendReply(group.id, `✅ Nome atualizado: '${prev}' → '${raw}' (aparecerá no ranking)`);
            } else {
              await sendReply(group.id, `✅ Nome definido: ${raw} (aparecerá no ranking)`);
            }
          } catch (e) {
            logger.error({ e, voterId, raw }, 'failed to set name');
            await sendReply(group.id, '❗ Falha ao salvar o nome. Tente novamente.');
          }
          continue;
        }

        // --- Admin: !resync-names (optional) - refreshes names for all users from contacts/group metadata
        if (ntext === '!resync-names') {
          // only allow if adminJid is configured and matches sender
            if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(msg.key.participant || msg.key.remoteJid)) {
            await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !resync-names.');
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
            await sendReply(group.id, `✅ Resync concluído. Nomes atualizados: ${changed}. Usuários verificados: ${users.length}.`);
          } catch (e) {
            logger.error({ e }, 'resync-names failed');
            await sendReply(group.id, '❗ Falha ao ressincronizar nomes. Veja os logs.');
          }
          continue;
        }

          // --- Admin: !fetch-contacts - attempt to resolve names for all group participants
          if (ntext === '!fetch-contacts') {
            if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(msg.key.participant || msg.key.remoteJid)) {
              await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !fetch-contacts.');
              continue;
            }
            try {
              const parts = (group && group.participants) ? group.participants.map((p) => p.id) : [];
              let changed = 0;
              for (const pid of parts) {
                try {
                  const res = await userUtils.resolveAndPersistName(sock, group, pid, null);
                  if (res && res.changed) changed += 1;
                } catch (e) {
                  logger.debug({ e, pid }, 'fetch-contacts: per-participant resolve failed');
                }
              }
              await db.write();
              await sendReply(group.id, `✅ fetch-contacts concluído. Nomes atualizados: ${changed}. Participantes verificados: ${parts.length}.`);
            } catch (e) {
              logger.error({ e }, 'fetch-contacts failed');
              await sendReply(group.id, '❗ Falha ao buscar contatos. Veja os logs.');
            }
            continue;
          }

          // --- Admin: !dump-users - print persisted users summary for debugging
          if (ntext === '!dump-users') {
            if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(msg.key.participant || msg.key.remoteJid)) {
              await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !dump-users.');
              continue;
            }
            try {
              await db.read();
              const users = Object.entries(db.data.users || {}).map(([jid, u]) => {
                return `${jid} — name: ${u.name || '[null]'} — xp: ${u.xp || 0} — votesCount: ${u.votesCount || 0} — lastSeen: ${u.lastSeenISO || '[none]'}`;
              });
              if (users.length === 0) {
                await sendReply(group.id, 'ℹ️ Nenhum usuário persistido em data.json.');
              } else {
                // send in chunks if long
                const chunkSize = 12;
                for (let i = 0; i < users.length; i += chunkSize) {
                  const chunk = users.slice(i, i + chunkSize).join('\n');
                  await safePost(sock, group.id, `📦 Usuários persistidos (parte ${Math.floor(i / chunkSize) + 1}/${Math.ceil(users.length / chunkSize)}):\n${chunk}`);
                }
              }
            } catch (e) {
              logger.error({ e }, 'dump-users failed');
              await safePost(sock, group.id, '❗ Falha ao listar usuários persistidos. Veja os logs.');
            }
            continue;
          }

          // --- Admin: !dedupe-users [dry|apply] - detect and optionally merge duplicate user entries
          if (ntext.startsWith('!dedupe-users')) {
            if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(msg.key.participant || msg.key.remoteJid)) {
              await safePost(sock, group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !dedupe-users.');
              continue;
            }
            const parts = ntext.split(/\s+/).slice(1);
            const mode = parts[0] || 'dry';
            try {
              const users = Object.keys(db.data.users || {});
              const map = {};
              for (const k of users) {
                const norm = jidNormalizedUser(k);
                map[norm] = map[norm] || [];
                map[norm].push(k);
              }
              const groups = Object.entries(map).filter(([, arr]) => arr.length > 1);
              if (groups.length === 0) {
                await safePost(sock, group.id, 'ℹ️ Nenhum usuário duplicado encontrado.');
                continue;
              }
              const reportLines = [];
              for (const [norm, originals] of groups) {
                reportLines.push(`- ${norm}: ${originals.join(', ')}`);
              }
              if (mode === 'dry') {
                await safePost(sock, group.id, `🔎 Dedupe dry-run encontrado ${groups.length} grupos de duplicados:\n${reportLines.join('\n')}`);
                continue;
              }
              if (mode === 'apply') {
                // backup data.json
                const backupName = `./data.json.bak.${Date.now()}`;
                try {
                  await fsp.writeFile(backupName, JSON.stringify(db.data, null, 2), 'utf8');
                } catch (e) {
                  logger.warn({ e, backupName }, 'failed to write backup before dedupe');
                  await safePost(sock, group.id, `❗ Falha ao criar backup ${backupName}. Aborting.`);
                  continue;
                }
                // perform merges
                for (const [norm, originals] of groups) {
                  // ensure canonical entry uses normalized jid
                  const canonical = norm;
                  ensureUser(canonical);
                  const target = db.data.users[canonical];
                  for (const orig of originals) {
                    if (orig === canonical) continue;
                    const src = db.data.users[orig];
                    if (!src) continue;
                    target.xp = (Number(target.xp || 0) + Number(src.xp || 0));
                    target.votesCount = (Number(target.votesCount || 0) + Number(src.votesCount || 0));
                    target.votedProposals = Object.assign({}, target.votedProposals || {}, src.votedProposals || {});
                    // prefer existing name, else take src
                    if (!target.name && src.name) target.name = src.name;
                    // keep most recent lastSeenISO
                    const a = target.lastSeenISO || null;
                    const b = src.lastSeenISO || null;
                    if (!a || (b && b > a)) target.lastSeenISO = b;
                    // remove src
                    delete db.data.users[orig];
                  }
                }
                await db.write();
                await safePost(sock, group.id, `✅ Dedupe aplicado. Backup salvo em ${backupName}. Grupos mesclados: ${groups.length}.`);
                continue;
              }
              await safePost(sock, group.id, "❗ Uso: !dedupe-users [dry|apply] — 'dry' mostra o relatório, 'apply' executa a mesclagem (faz backup)." );
            } catch (e) {
              logger.error({ e }, 'dedupe-users failed');
              await safePost(sock, group.id, '❗ Falha ao executar dedupe-users. Veja os logs.');
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
            if (isDm) {
              const ok = await requireGroupContext();
              if (!ok) { await safePost(sock, group.id, 'ℹ️ Este comando precisa do contexto do grupo.'); continue; }
            }
          // Ensure we have the latest DB contents (pick up recent !setnome writes)
          try { await db.read(); } catch (e) { logger.debug({ e }, 'db.read failed in ranking'); }
          // Build union of sources: DB users, group participants, socket contacts, and proposal voters
          const usersMap = {};
          const dbUsers = listUsers() || {};

          // Seed from DB (persisted users) - prefer these names and xp
          for (const [jid, data] of Object.entries(dbUsers)) {
            const norm = jidNormalizedUser(jid);
            usersMap[norm] = { jid: norm, name: data.name || null, xp: Number(data.xp || 0), votesCount: 0 };
          }

          // Add group participants (ensure they appear even if not in DB)
          try {
            const parts = (group && group.participants) ? group.participants.map((p) => p.id) : [];
            for (const pid of parts) {
              const norm = jidNormalizedUser(pid);
              if (!usersMap[norm]) usersMap[norm] = { jid: norm, name: null, xp: 0, votesCount: 0 };
            }
          } catch (e) { logger.debug({ e }, 'failed to include group participants in ranking seed'); }

          // Add sock.contacts if available
          try {
            const contactKeys = sock.contacts ? Object.keys(sock.contacts) : [];
            for (const k of contactKeys) {
              const norm = jidNormalizedUser(k);
              if (!usersMap[norm]) usersMap[norm] = { jid: norm, name: null, xp: 0, votesCount: 0 };
            }
          } catch (e) { logger.debug({ e }, 'failed to include sock.contacts in ranking seed'); }

          // Compute votesCount from proposals (authoritative source for votes)
          for (const p of db.data.proposals || []) {
            if (p.groupJid !== group.id) continue;
            for (const voterJid of Object.keys(p.votes || {})) {
              const norm = jidNormalizedUser(voterJid);
              if (!usersMap[norm]) usersMap[norm] = { jid: norm, name: null, xp: 0, votesCount: 0 };
              usersMap[norm].votesCount = (usersMap[norm].votesCount || 0) + 1;
              // if DB has a name for this normalized jid, prefer it
              if ((!usersMap[norm].name || usersMap[norm].name === null) && dbUsers && dbUsers[norm] && dbUsers[norm].name) {
                usersMap[norm].name = dbUsers[norm].name;
                usersMap[norm].xp = Number(dbUsers[norm].xp || 0);
              }
            }
          }

          const allRows = Object.values(usersMap || {});
          // debug info: counts of seed sources
          try {
            const dbCount = Object.keys(dbUsers || {}).length;
            const partCount = (group && group.participants) ? group.participants.length : 0;
            const contactCount = sock.contacts ? Object.keys(sock.contacts).length : 0;
            const votersCount = (db.data.proposals || []).reduce((acc, p) => acc + (p.groupJid === group.id ? Object.keys(p.votes || {}).length : 0), 0);
            logger.info({ dbCount, partCount, contactCount, votersCount, allRowsCount: allRows.length }, 'ranking seed counts');
          } catch (e) {
            logger.debug({ e }, 'ranking debug counts failed');
          }
          if (!allRows || allRows.length === 0) {
            await safePost(sock, group.id, 'ℹ️ Nenhum usuário registrado ainda.');
            continue;
          }

          // Enrich display name with fallbacks: DB name -> group metadata -> sock.getName -> sock.contacts -> JID local part
          const resolvedRows = [];
          for (const r of allRows) {
            let display = r.name || null;
            try {
              const part = (group && group.participants) ? (group.participants.find((p) => p.id === r.jid) || null) : null;
              if (!display && part) display = part?.name || part?.notify || part?.pushname || null;
            } catch (e) {}

            if (!display) {
              try {
                if (typeof sock.getName === 'function') {
                  const n = await sock.getName(r.jid).catch(() => null);
                  if (n) display = n;
                }
                if (!display && sock.contacts && sock.contacts[r.jid]) {
                  const c = sock.contacts[r.jid];
                  display = c.name || c.notify || c.vname || null;
                }
              } catch (e) {}
            }

            if (!display) display = r.jid ? r.jid.split('@')[0] : 'Unknown';
            resolvedRows.push({ jid: r.jid, name: display, xp: Number(r.xp || 0), votesCount: Number(r.votesCount || 0) });
          }

          const rows = resolvedRows.sort((a, b) => b.votesCount - a.votesCount || b.xp - a.xp).slice(0, 50);
          const maxXp = Math.max(...rows.map((r) => r.xp || 0), 1);

          const lines = rows.map((row, i) => {
            const lvl = levelFromXp(row.xp || 0);
            const title = titleForLevel(lvl.level);
            const badge = helpers.badgeForLevel(lvl.level);
            const bar = helpers.progressBar(lvl.xpIntoLevel, lvl.xpForNextLevel, 12);
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
            if (isDm) {
              const ok = await requireGroupContext();
              if (!ok) { await safePost(sock, group.id, 'ℹ️ Para votar, o bot precisa do contexto do grupo (pautas).'); continue; }
            }
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
                try {
                  await userUtils.resolveAndPersistName(sock, group, voterId, sender);
                } catch (e) {
                  logger.debug({ e, voterId, sender }, 'resolveAndPersistName failed after vote');
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
                    await userUtils.resolveAndPersistName(sock, group, voterId, sender);
                  } catch (e) {
                    logger.debug({ e, voterId, sender }, 'resolveAndPersistName failed after vote');
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
                    await userUtils.resolveAndPersistName(sock, group, voterId, sender);
                  } catch (e) {
                    logger.debug({ e, voterId, sender }, 'resolveAndPersistName failed after vote');
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
                        await userUtils.resolveAndPersistName(sock, group, voterId, sender);
                      } catch (e) {
                        logger.debug({ e, voterId, sender }, 'resolveAndPersistName failed after sticker vote');
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
                            await userUtils.resolveAndPersistName(sock, group, voterId, sender);
                          } catch (e) {
                            logger.debug({ e, voterId, sender }, 'resolveAndPersistName failed after sticker vote');
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
