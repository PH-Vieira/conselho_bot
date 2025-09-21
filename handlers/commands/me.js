/**
 * Handle the `!me` command: show the caller's profile summary.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text used for command matching
 * - `sendReply`: helper to reply in DM or group depending on origin
 * - `group`: group metadata (used to determine where to reply)
 * - `sender`: display name used in messages
 * - `helpers`: utility helpers that provide level/xp rendering and badges
 * - `jidNormalizedUser`: helper to normalize JIDs for lookup
 * - `db`: database object containing `db.data.users`
 * - `msg`: the original message envelope (used to extract participant JID)
 * - `ensureUser`: function to ensure a `db.data.users[<jid>]` entry exists
 *
 * Behavior:
 * - Returns `false` if the message is not `!me`.
 * - Ensures the calling user has a persisted entry, computes level/badge
 *   information and sends a formatted summary back to the caller's
 *   appropriate destination. Returns `true` when handled.
 */
export default async function me(ctx) {
  const { ntext, sendReply, group, sender, helpers, jidNormalizedUser, db } = ctx;
  if (ntext !== '!me') return false;
  const voterId = jidNormalizedUser(ctx.msg.key.participant || ctx.msg.key.remoteJid);
  ctx.ensureUser(voterId);
  // prefer group-scoped user data when available
  let u = { xp: 0, votesCount: 0 };
  try {
    if (group && group.id && db.data.groups && db.data.groups[group.id] && db.data.groups[group.id].users && db.data.groups[group.id].users[voterId]) {
      u = db.data.groups[group.id].users[voterId];
    } else {
      u = db.data.users[voterId] || u;
    }
  } catch (e) {
    u = db.data.users[voterId] || u;
  }
  const lvl = helpers.levelFromXp ? helpers.levelFromXp(u.xp || 0) : ctx.levelFromXp(u.xp || 0);
  const title = ctx.titleForLevel ? ctx.titleForLevel(lvl.level) : ctx.titleForLevel(lvl.level);
  const badge = helpers.badgeForLevel ? helpers.badgeForLevel(lvl.level) : '';
  const bar = helpers.progressBar ? helpers.progressBar(lvl.xpIntoLevel, lvl.xpForNextLevel, 12) : '';
  const emoji = helpers.pickRandom ? helpers.pickRandom(helpers.EMOJI_POOLS.confirm) : '';
  const msgText = [];
  // prefer persisted name from group-scoped user or global before sender
  const displayName = (group && group.id && db.data.groups && db.data.groups[group.id] && db.data.groups[group.id].users && db.data.groups[group.id].users[voterId] && db.data.groups[group.id].users[voterId].name) ? db.data.groups[group.id].users[voterId].name : (db.data.users[voterId] && db.data.users[voterId].name) ? db.data.users[voterId].name : sender;
  msgText.push(`${badge} 👤 ${displayName} — *Nível ${lvl.level}* (${title})`);
  msgText.push(`XP: ${u.xp || 0} (${lvl.xpIntoLevel}/${lvl.xpForNextLevel}) ${bar}`);
  msgText.push(`Votos registrados: ${u.votesCount || 0} ${emoji}`);
  await sendReply(group.id, msgText.join('\n'));
  return true;
}
