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
  const u = db.data.users[voterId] || { xp: 0, votesCount: 0 };
  const lvl = helpers.levelFromXp ? helpers.levelFromXp(u.xp || 0) : ctx.levelFromXp(u.xp || 0);
  const title = ctx.titleForLevel ? ctx.titleForLevel(lvl.level) : ctx.titleForLevel(lvl.level);
  const badge = helpers.badgeForLevel ? helpers.badgeForLevel(lvl.level) : '';
  const bar = helpers.progressBar ? helpers.progressBar(lvl.xpIntoLevel, lvl.xpForNextLevel, 12) : '';
  const emoji = helpers.pickRandom ? helpers.pickRandom(helpers.EMOJI_POOLS.confirm) : '';
  // prefer explicit persisted name (from !setnome) before the runtime sender name
  const displayName = (u && u.name) ? u.name : sender;
  const msgText = [];
  msgText.push(`${badge} 👤 ${displayName} — *Nível ${lvl.level}* (${title})`);
  msgText.push(`XP: ${u.xp || 0} (${lvl.xpIntoLevel}/${lvl.xpForNextLevel}) ${bar}`);
  msgText.push(`Votos registrados: ${u.votesCount || 0} ${emoji}`);
  await sendReply(group.id, msgText.join('\n'));
  return true;
}
