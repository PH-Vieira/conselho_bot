/**
 * Handle the `!pauta` command which creates a new proposal (pauta).
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized/lowercased text used for command detection
 * - `text`: original message text (preserves case and tokens)
 * - `isDm`: boolean, true when the message originated in a private chat
 * - `requireGroupContext`: async helper that ensures `group` metadata is
 *    available (useful when the command was sent via DM but requires the
 *    configured group)
 * - `sendReply`: helper to reply to the appropriate destination (DM vs group)
 * - `group`: group metadata object (must include `id`)
 * - `nanoid`: id generator used to create short proposal ids
 * - `db`: lowdb-like database object with `data.proposals` array
 * - `helpers`: utility helpers (deadline computation, normalization, etc.)
 * - `CONFIG`: runtime configuration (contains `voteWindowHours` fallback)
 * - `logger`: logger instance for debug/info
 * - `sender`: display name of the author (best-effort resolved)
 *
 * Behavior:
 * - Syntax: `!pauta <título> [<tempo>]` where `<tempo>` can be shorthand
 *   like `48h` or `30m`, or separated by `|` or `-` tokens.
 * - Generates a 5-char id with `nanoid(5)` and stores a proposal object in
 *   `db.data.proposals` with `openedAtISO`, `deadlineISO`, and empty `votes`.
 * - Replies with confirmation text and returns `true` when the command
 *   was handled. Returns `false` when the message is not a `!pauta` command.
 */
export default async function pauta(ctx) {
  const { ntext, text, isDm, requireGroupContext, sendReply, group, nanoid, db, helpers, CONFIG, logger, sender } = ctx;
  if (!ntext.startsWith('!pauta ')) return false;
  if (isDm) {
    const ok = await requireGroupContext();
    if (!ok) {
      await sendReply(group.id, 'ℹ️ Este comando só funciona em grupo. Ou inicie uma DM com o bot para usar comandos pessoais como !setnome ou configure `groupJid` para permitir uso via DM.');
      return true;
    }
  }
  const rest = text.slice(7).trim();
  if (!rest) {
    await sendReply(group.id, '❗ Use: !pauta <título da pauta> [<tempo>]');
    return true;
  }
  let title = rest;
  let timeToken = null;
  const parts = rest.split(/\||;|\s-\s/).map((s) => s.trim()).filter(Boolean);
  if (parts.length > 1) {
    title = parts.slice(0, -1).join(' | ');
    timeToken = parts[parts.length - 1];
  } else {
    const spaceParts = rest.split(/\s+/);
    const last = spaceParts[spaceParts.length - 1];
    if (/^\[?\(?\d+(h|m)?\)?\]?$/i.test(last)) {
      timeToken = last;
      title = spaceParts.slice(0, -1).join(' ');
    }
  }
  const id = nanoid(5);
  const openedAtISO = new Date().toISOString();
  let deadlineISO;
  if (timeToken) {
    timeToken = timeToken.replace(/^[\[\(]+|[\]\)]+$/g, '');
    timeToken = timeToken.replace(/[.,\s]+$/g, '');
    const m = timeToken.match(/^(\d+)(h|hr|hours|m|min|minutes)?$/i);
    if (m) {
      const num = Number(m[1]);
      const unitToken = (m[2] || 'h').toLowerCase();
      const isMinutes = ['m', 'min', 'minutes'].includes(unitToken);
      if (isMinutes) deadlineISO = helpers.computeDeadlineFromMinutes(openedAtISO, num);
      else deadlineISO = helpers.computeDeadline(openedAtISO, num);
    } else {
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
    status: 'open'
  });
  await db.write();
  await sendReply(group.id, `✅ Pauta criada: *${title}* (id: ${id}). Use !votar ${id} sim/nao para votar.`);
  return true;
}
