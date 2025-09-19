/**
 * Handle the `!setnome` command which allows a user to set a display name
 * that will be shown in the ranking and other user-facing outputs.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text used for command detection
 * - `text`: original message text (used to extract the provided name)
 * - `sendReply`: helper to reply to DM or group appropriately
 * - `group`: group metadata (destination id used for replies)
 * - `jidNormalizedUser`: helper to normalize the caller's JID
 * - `db`: database object to persist the `name` on `db.data.users[<jid>]`
 * - `logger`: logger for error reporting
 * - `ensureUser`: helper to create a user entry if missing
 * - `msg`: original message envelope (used to compute participant JID)
 *
 * Behavior:
 * - Syntax: `!setnome <seu nome>`
 * - Persists `db.data.users[voterId].name = <provided name>` and writes
 *   to disk. Replies with confirmation. Returns `true` when handled.
 */
export default async function setnome(ctx) {
  const { ntext, text, sendReply, group, jidNormalizedUser, db, logger } = ctx;
  if (!ntext.startsWith('!setnome')) return false;
  const raw = text.split(/\s+/).slice(1).join(' ').trim();
  const voterId = jidNormalizedUser(ctx.msg.key.participant || ctx.msg.key.remoteJid);
  if (!raw) {
    await sendReply(group.id, `❗ Uso: !setnome <seu nome> — ex.: !setnome João Silva`);
    return true;
  }
  try {
    await db.read();
    ctx.ensureUser(voterId);
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
  return true;
}
