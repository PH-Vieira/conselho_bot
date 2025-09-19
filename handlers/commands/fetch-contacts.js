/**
 * Admin utility: attempt to resolve and persist display names for all group
 * participants by consulting `userUtils.resolveAndPersistName`.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text for command detection
 * - `sendReply`: helper to reply in DM or group
 * - `group`: group metadata (participants list used as the source)
 * - `db`: database object (writes are flushed at the end)
 * - `jidNormalizedUser`: helper to normalize JIDs for admin check
 * - `logger`: logger for diagnostics
 * - `CONFIG`: app configuration (`adminJid` required to run)
 * - `userUtils`: helper module exposing `resolveAndPersistName`
 * - `msg`: original message envelope (to detect caller JID)
 *
 * Behavior:
 * - Only the configured `CONFIG.adminJid` may run this command.
 * - Iterates group participants and calls `userUtils.resolveAndPersistName`
 *   to populate `db.data.users[<jid>].name`. Writes DB once and reports
 *   the number of names updated.
 */
export default async function fetchContacts(ctx) {
  const { ntext, sendReply, group, db, jidNormalizedUser, logger, CONFIG, userUtils } = ctx;
  if (ntext !== '!fetch-contacts') return false;
  if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(ctx.msg.key.participant || ctx.msg.key.remoteJid)) {
    await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !fetch-contacts.');
    return true;
  }
  try {
    const parts = (group && group.participants) ? group.participants.map((p) => p.id) : [];
    let changed = 0;
    for (const pid of parts) {
      try {
        const res = await userUtils.resolveAndPersistName(ctx.sock, group, pid, null);
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
  return true;
}
