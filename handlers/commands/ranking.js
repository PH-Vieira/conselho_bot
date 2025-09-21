/**
 * Handle the `!ranking` command: compute and display a participation
 * ranking for the configured group.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text used for command matching
 * - `sendReply`: helper to reply to DM or group appropriately
 * - `group`: group metadata (must be present or `requireGroupContext` used prior)
 * - `db`: database object containing `db.data.proposals`
 * - `listUsers`: helper that returns persisted `db.data.users` mapping
 * - `jidNormalizedUser`: function to normalize JIDs
 * - `sock`: baileys socket used to read `contacts` or call `getName`
 * - `helpers`: utility functions for progress bars, normalization, etc.
 * - `levelFromXp`, `titleForLevel`: functions to compute level/label
 *
 * Algorithm (high level):
 * 1. Seed users from persisted DB users (preferring persisted `name` and `xp`).
 * 2. Add group participants and socket contacts to ensure everyone is
 *    represented even if they haven't used the bot.
 * 3. Count votes by iterating proposals and accumulating `votesCount` per
 *    normalized JID (authoritative vote source).
 * 4. Resolve display names with fallback order: DB name -> group
 *    participant metadata -> `sock.getName` -> `sock.contacts` -> JID
 * 5. Sort by votes, then XP, and format a compact leaderboard message.
 *
 * Returns `true` when handled and `false` if the message is not `!ranking`.
 */
export default async function ranking(ctx) {
  const { ntext, sendReply, group, db, listUsers, jidNormalizedUser, sock, helpers, levelFromXp, titleForLevel } = ctx;
  if (ntext !== '!ranking') return false;
  try { await db.read(); } catch (e) {}
  const usersMap = {};
  const dbUsers = listUsers() || {};
  for (const [jid, data] of Object.entries(dbUsers)) {
    const norm = jidNormalizedUser(jid);
    // prefer group-scoped data when available
    let name = data.name || null;
    let xp = Number(data.xp || 0);
    try {
      if (db.data.groups && db.data.groups[group.id] && db.data.groups[group.id].users && db.data.groups[group.id].users[norm]) {
        const gu = db.data.groups[group.id].users[norm];
        name = gu.name || name;
        xp = Number(gu.xp || xp || 0);
      }
    } catch (e) {}
    usersMap[norm] = { jid: norm, name: name, xp: xp, votesCount: 0 };
  }
  try {
    const parts = (group && group.participants) ? group.participants.map((p) => p.id) : [];
    for (const pid of parts) {
      const norm = jidNormalizedUser(pid);
      if (!usersMap[norm]) usersMap[norm] = { jid: norm, name: null, xp: 0, votesCount: 0 };
    }
  } catch (e) {}
  try {
    const contactKeys = sock.contacts ? Object.keys(sock.contacts) : [];
    for (const k of contactKeys) {
      const norm = jidNormalizedUser(k);
      if (!usersMap[norm]) usersMap[norm] = { jid: norm, name: null, xp: 0, votesCount: 0 };
    }
  } catch (e) {}
  for (const p of db.data.proposals || []) {
    if (p.groupJid !== group.id) continue;
    for (const voterJid of Object.keys(p.votes || {})) {
      const norm = jidNormalizedUser(voterJid);
      if (!usersMap[norm]) usersMap[norm] = { jid: norm, name: null, xp: 0, votesCount: 0 };
      usersMap[norm].votesCount = (usersMap[norm].votesCount || 0) + 1;
      if ((!usersMap[norm].name || usersMap[norm].name === null) && dbUsers && dbUsers[norm] && dbUsers[norm].name) {
        usersMap[norm].name = dbUsers[norm].name;
        usersMap[norm].xp = Number(dbUsers[norm].xp || 0);
      }
    }
  }
  const allRows = Object.values(usersMap || {});
  if (!allRows || allRows.length === 0) {
    await sendReply(group.id, 'ℹ️ Nenhum usuário registrado ainda.');
    return true;
  }
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
  const rows = resolvedRows.filter(r => Number(r.xp || 0) > 0).sort((a, b) => b.votesCount - a.votesCount || b.xp - a.xp).slice(0, 50);
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
  await sendReply(group.id, `🏆 Ranking de Participação:\n${lines.join('\n\n')}`);
  return true;
}
