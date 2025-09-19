/**
 * Admin utility: resynchronize persisted `db.data.users[*].name` fields using
 * the best available metadata sources.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text used for matching the command
 * - `sendReply`: helper to reply in DM or group
 * - `group`: group metadata (used to inspect participant metadata)
 * - `db`: database object containing `db.data.users`
 * - `jidNormalizedUser`: helper to normalize stored JIDs
 * - `logger`: logger for diagnostics
 * - `CONFIG`: app configuration (contains `adminJid` for access control)
 * - `sock`: baileys socket (used to call `getName` and read `contacts`)
 *
 * Behavior:
 * - Only the configured `CONFIG.adminJid` may run this command.
 * - Iterates persisted users and attempts to update missing/older names by
 *   checking group participant metadata, `sock.getName`, and `sock.contacts`.
 * - Writes updates to disk and reports the number of names changed.
 */
export default async function resyncNames(ctx) {
  const { ntext, sendReply, group, db, jidNormalizedUser, logger, CONFIG, sock } = ctx;
  if (ntext !== '!resync-names') return false;
  if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(ctx.msg.key.participant || ctx.msg.key.remoteJid)) {
    await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !resync-names.');
    return true;
  }
  try {
    const users = Object.keys(db.data.users || {});
    let changed = 0;
    for (const u of users) {
      try {
        const norm = jidNormalizedUser(u);
        let resolved = db.data.users[u].name || null;
        try {
          const part = (group && group.participants) ? (group.participants.find((p) => p.id === norm) || null) : null;
          resolved = resolved || part?.name || part?.notify || part?.pushname || null;
        } catch (e) {}
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
  return true;
}
