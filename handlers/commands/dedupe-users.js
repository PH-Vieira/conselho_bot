import fs from 'fs';
const fsp = fs.promises;

/**
 * Admin utility: detect and optionally merge duplicate user entries in
 * `db.data.users` that map to the same normalized JID.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text used to match the command (supports `dry` or `apply`)
 * - `sendReply`: helper to reply in DM or group
 * - `group`: group metadata for reply destination
 * - `db`: database object containing `db.data.users`
 * - `jidNormalizedUser`: helper to normalize JIDs
 * - `logger`: logger for diagnostics
 * - `CONFIG`: app configuration (`adminJid` required to run)
 * - `ensureUser`: helper that ensures a user entry exists for a JID
 * - `msg`: original message envelope (to check caller)
 *
 * Behavior:
 * - `!dedupe-users dry` lists groups of duplicate keys mapping to the same
 *   normalized JID (no changes).
 * - `!dedupe-users apply` creates a backup of `data.json`, then merges
 *   duplicate entries into the canonical normalized JID entry, summing XP,
 *   votesCount and merging voted proposals. Returns a summary on success.
 */
export default async function dedupeUsers(ctx) {
  const { ntext, sendReply, group, db, jidNormalizedUser, logger, CONFIG, ensureUser } = ctx;
  if (!ntext.startsWith('!dedupe-users')) return false;
  if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(ctx.msg.key.participant || ctx.msg.key.remoteJid)) {
    await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !dedupe-users.');
    return true;
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
      await sendReply(group.id, 'ℹ️ Nenhum usuário duplicado encontrado.');
      return true;
    }
    const reportLines = [];
    for (const [norm, originals] of groups) reportLines.push(`- ${norm}: ${originals.join(', ')}`);
    if (mode === 'dry') {
      await sendReply(group.id, `🔎 Dedupe dry-run encontrado ${groups.length} grupos de duplicados:\n${reportLines.join('\n')}`);
      return true;
    }
    if (mode === 'apply') {
      const backupName = `./data.json.bak.${Date.now()}`;
      try { await fsp.writeFile(backupName, JSON.stringify(db.data, null, 2), 'utf8'); } catch (e) { logger.warn({ e, backupName }, 'failed to write backup before dedupe'); await sendReply(group.id, `❗ Falha ao criar backup ${backupName}. Aborting.`); return true; }
      for (const [norm, originals] of groups) {
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
          if (!target.name && src.name) target.name = src.name;
          const a = target.lastSeenISO || null;
          const b = src.lastSeenISO || null;
          if (!a || (b && b > a)) target.lastSeenISO = b;
          delete db.data.users[orig];
        }
      }
      await db.write();
      await sendReply(group.id, `✅ Dedupe aplicado. Backup salvo em ${backupName}. Grupos mesclados: ${groups.length}.`);
      return true;
    }
    await sendReply(group.id, "❗ Uso: !dedupe-users [dry|apply] — 'dry' mostra o relatório, 'apply' executa a mesclagem (faz backup)." );
  } catch (e) {
    logger.error({ e }, 'dedupe-users failed');
    await sendReply(group.id, '❗ Falha ao executar dedupe-users. Veja os logs.');
  }
  return true;
}
