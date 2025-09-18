import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import { levelFromXp } from './helpers.js';

const adapter = new JSONFile('./data.json');
export const db = new Low(adapter, { proposals: [], groups: {}, pendingSelections: {}, users: {} });

export async function initDb() {
  await db.read();
  if (!db.data) db.data = { proposals: [], groups: {}, pendingSelections: {}, users: {} };
  if (!db.data.pendingSelections) db.data.pendingSelections = {};
  if (!db.data.users) db.data.users = {};
  await db.write();
}

export function cleanupPendingSelections() {
  const now = new Date().toISOString();
  db.data = db.data || {};
  db.data.pendingSelections = db.data.pendingSelections || {};
  for (const [k, v] of Object.entries(db.data.pendingSelections)) {
    if (!v || !v.expiresAtISO || v.expiresAtISO < now) {
      delete db.data.pendingSelections[k];
    }
  }
}

// User helpers: ensure user exists, record vote for proposal, and increment counters
export function ensureUser(jid) {
  db.data = db.data || {};
  db.data.users = db.data.users || {};
  if (!db.data.users[jid]) {
    db.data.users[jid] = { xp: 0, votesCount: 0, votedProposals: {}, lastSeenISO: null };
  }
  return db.data.users[jid];
}

export async function recordUserVoteOnce(jid, proposalId, xpPerVote = 10) {
  // returns detailed info: { awarded: boolean, xpAwarded, oldXp, newXp, oldLevel, newLevel }
  ensureUser(jid);
  const user = db.data.users[jid];
  user.lastSeenISO = new Date().toISOString();
  const oldXp = Number(user.xp || 0);
  const oldLevel = levelFromXp(oldXp).level;
  if (user.votedProposals && user.votedProposals[proposalId]) {
    // already counted for XP on this proposal
    return { awarded: false, xpAwarded: 0, oldXp, newXp: oldXp, oldLevel, newLevel: oldLevel };
  }
  user.votedProposals = user.votedProposals || {};
  user.votedProposals[proposalId] = true;
  user.votesCount = (user.votesCount || 0) + 1;
  user.xp = (user.xp || 0) + xpPerVote;
  const newXp = Number(user.xp || 0);
  const newLevel = levelFromXp(newXp).level;
  await db.write();
  return { awarded: true, xpAwarded: xpPerVote, oldXp, newXp, oldLevel, newLevel };
}

export function listUsers() {
  db.data = db.data || {};
  db.data.users = db.data.users || {};
  return db.data.users;
}
