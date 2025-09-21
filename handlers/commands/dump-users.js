/**
 * Admin utility: print a summary of persisted users from `data.json`.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text used to match the command
 * - `sendReply`: helper to reply in DM or group
 * - `group`: group metadata used for reply destination
 * - `db`: database object containing `db.data.users`
 * - `jidNormalizedUser`: helper to normalize JIDs
 * - `logger`: logger instance for errors
 * - `CONFIG`: application configuration (provides `adminJid`)
 * - `msg`: original message envelope (to infer caller JID)
 *
 * Behavior:
 * - Only the configured `CONFIG.adminJid` may run this command; others
 *   receive a restricted message.
 * - Reads `db.data.users` and sends the entries in chunks to avoid message
 *   length limits. Returns `true` when handled.
 */
export default async function dumpUsers(ctx) {
  const { ntext, sendReply, group, db, jidNormalizedUser, logger, CONFIG } = ctx;
  if (ntext !== '!dump-users') return false;
  if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== jidNormalizedUser(ctx.msg.key.participant || ctx.msg.key.remoteJid)) {
    await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !dump-users.');
    return true;
  }
  try {
    await db.read();
    const globalUsers = Object.entries(db.data.users || {}).map(([jid, u]) => `${jid} — name: ${u.name || '[null]'} — xp: ${u.xp || 0} — votesCount: ${u.votesCount || 0} — lastSeen: ${u.lastSeenISO || '[none]'}`);
    const groupUsersObj = (db.data.groups && db.data.groups[group.id] && db.data.groups[group.id].users) ? db.data.groups[group.id].users : {};
    const groupUsers = Object.entries(groupUsersObj).map(([jid, u]) => `${jid} — name: ${u.name || '[null]'} — xp: ${u.xp || 0} — votesCount: ${u.votesCount || 0} — lastSeen: ${u.lastSeenISO || '[none]'}`);

    const chunkSize = 12;
    if (globalUsers.length === 0) {
      await sendReply(group.id, 'ℹ️ Nenhum usuário global persistido em data.json.');
    } else {
      for (let i = 0; i < globalUsers.length; i += chunkSize) {
        const chunk = globalUsers.slice(i, i + chunkSize).join('\n');
        await sendReply(group.id, `📦 Usuários globais persistidos (parte ${Math.floor(i / chunkSize) + 1}/${Math.ceil(globalUsers.length / chunkSize)}):\n${chunk}`);
      }
    }
    if (groupUsers.length === 0) {
      await sendReply(group.id, 'ℹ️ Nenhum usuário escopado ao grupo persistido.');
    } else {
      for (let i = 0; i < groupUsers.length; i += chunkSize) {
        const chunk = groupUsers.slice(i, i + chunkSize).join('\n');
        await sendReply(group.id, `📦 Usuários do grupo persistidos (parte ${Math.floor(i / chunkSize) + 1}/${Math.ceil(groupUsers.length / chunkSize)}):\n${chunk}`);
      }
    }
  } catch (e) {
    logger.error({ e }, 'dump-users failed');
    await sendReply(group.id, '❗ Falha ao listar usuários persistidos. Veja os logs.');
  }
  return true;
}
