import dayjs from 'dayjs';
import CONFIG from './config.js';
import logger from './logger.js';

// Emoji / personality helpers
export const EMOJI_POOLS = {
  praise: ['🎉', '👏', '✨', '🥳', '🛡️'],
  confirm: ['✅', '👍', '👌'],
  deny: ['❌', '👎', '🚫'],
  levelUp: ['🏆', '🚀', '🌟', '🎖️'],
};

export function pickRandom(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return '';
  return arr[Math.floor(Math.random() * arr.length)];
}

export function normalizeText(t = '') {
  return t
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .trim();
}

export function isYesToken(text) {
  const n = normalizeText(String(text || ''));
  return (CONFIG.tokens?.yes || []).some((tk) => n === normalizeText(String(tk)));
}

export function isNoToken(text) {
  const n = normalizeText(String(text || ''));
  return (CONFIG.tokens?.no || []).some((tk) => n === normalizeText(String(tk)));
}

export function matchStickerHash(md5) {
  if (!md5) return null;
  // md5 is expected normally as a hex string. Some users may register stickers
  // as comma-separated byte lists (e.g. '42,112,...'). Support both by
  // comparing the hex and the comma-byte representation.
  const hex = String(md5 || '').toLowerCase();
  let comma = hex;
  try {
    // if hex looks like hex, convert to comma bytes
    if (/^[0-9a-f]+$/i.test(hex)) {
      const buf = Buffer.from(hex, 'hex');
      comma = Array.from(buf).join(',');
    }
  } catch (e) {
    // fallback: leave comma as original
    comma = String(md5);
  }

  const yesHit = (CONFIG.stickers?.yes || []).some((v) => String(v).toLowerCase() === hex || String(v) === comma);
  const noHit = (CONFIG.stickers?.no || []).some((v) => String(v).toLowerCase() === hex || String(v) === comma);
  const councilHit = (CONFIG.stickers?.council || []).some((v) => String(v).toLowerCase() === hex || String(v) === comma);
  if (yesHit) return 'yes';
  if (noHit) return 'no';
  if (councilHit) return 'council';
  return null;
}

export function computeDeadline(openedAtISO, hours) {
  return dayjs(openedAtISO).add(hours, 'hour').toISOString();
}

export function computeDeadlineFromMinutes(openedAtISO, minutes) {
  return dayjs(openedAtISO).add(minutes, 'minute').toISOString();
}

export function isPast(iso) {
  return dayjs().isAfter(dayjs(iso));
}

export function humanTimeLeft(deadlineISO) {
  const d = dayjs(deadlineISO);
  const now = dayjs();
  const diffSeconds = d.diff(now, 'second');
  if (diffSeconds <= 0) return 'encerrada';
  const diffMin = Math.ceil(diffSeconds / 60);
  if (diffMin < 60) return `${diffMin} min`;
  const hrs = Math.floor(diffMin / 60);
  const min = diffMin % 60;
  return `${hrs}h ${min}min`;
}

export function formatToUTCMinus3(iso) {
  if (!iso) return '';
  try {
    // utcOffset accepts minutes; -180 = UTC-3
    return dayjs(iso).utcOffset(-180).format('YYYY-MM-DD HH:mm [UTC-3]');
  } catch (e) {
    logger.debug({ e, iso }, 'formatToUTCMinus3 failed');
    return iso;
  }
}

export async function groupSize(sock, jid) {
  try {
    const meta = await sock.groupMetadata(jid);
    return meta?.participants?.length || 0;
  } catch (err) {
    logger.warn({ err }, 'Erro ao obter metadata do grupo');
    return 0;
  }
}

export async function getGroupByName(sock, name) {
  const { groups } = await sock.groupFetchAllParticipating();
  const arr = Object.values(groups || {});
  return arr.find((g) => (g.subject || '').trim() === (name || '').trim());
}

export function summarizeVotes(votes) {
  let yes = 0,
    no = 0;
  for (const v of Object.values(votes || {})) {
    const vote = typeof v === 'string' ? v : v?.vote;
    if (vote === 'yes') yes++;
    else if (vote === 'no') no++;
  }
  return { yes, no };
}

// --- Level / XP system helpers ---
// Example progression: each level requires 100 * (level + 1) XP (arbitrary tuning)
export function xpForLevel(level) {
  // cumulative XP required to reach given level (level 0 requires 0)
  // We'll use triangular progression: sum_{i=1..level} base*i
  const base = 100;
  let total = 0;
  for (let i = 1; i <= level; i++) total += base * i;
  return total;
}

export function levelFromXp(xp) {
  xp = Number(xp || 0);
  let level = 0;
  while (xp >= xpForLevel(level + 1)) level++;
  const currentLevelXp = xpForLevel(level);
  const nextLevelXp = xpForLevel(level + 1);
  return { level, xpIntoLevel: xp - currentLevelXp, xpForNextLevel: nextLevelXp - currentLevelXp };
}

export const COUNCIL_TITLES = [
  'Aspirante',
  'Conselheiro Júnior',
  'Conselheiro',
  'Conselheiro Sênior',
  'Guardião do Conselho',
  'Arqui-Conselheiro',
];

export function titleForLevel(level) {
  // map level to title; clamp to last title after exceeding
  const idx = Math.min(level, COUNCIL_TITLES.length - 1);
  return COUNCIL_TITLES[idx] || COUNCIL_TITLES[COUNCIL_TITLES.length - 1];
}

// Badges per level (can be expanded)
export const BADGES = ['🟢', '🔵', '🟣', '🟡', '🛡️', '🏅'];

export function badgeForLevel(level) {
  const idx = Math.min(level, BADGES.length - 1);
  return BADGES[idx] || BADGES[BADGES.length - 1];
}

// Render a simple progress bar string: [#####-----] 50%
export function progressBar(current, total, width = 10) {
  const cur = Number(current || 0);
  const tot = Number(total || 1);
  const pct = Math.max(0, Math.min(1, tot === 0 ? 0 : cur / tot));
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = '[' + '█'.repeat(filled) + '░'.repeat(empty) + `] ${Math.round(pct * 100)}%`;
  return bar;
}

// Compute XP for a proposal dynamically based on its duration.
// Shorter proposals award more XP (they're 'urgent'); longer proposals award less.
// Parameters:
//  - openedAtISO, deadlineISO: ISO timestamps
//  - baseXp: base XP value (usually CONFIG.xpPerVote or default)
// Strategy (tunable):
//  - Compute duration in hours (min 0.01 to avoid division by zero).
//  - Use an inverse scaling: multiplier = clamp(k / durationHours, minMult, maxMult)
//  - xp = Math.round(baseXp * multiplier)
export function xpForProposal(openedAtISO, deadlineISO, baseXp = 10) {
  try {
    const opened = dayjs(openedAtISO);
    const deadline = dayjs(deadlineISO);
    let hours = Math.max(0.01, Math.abs(deadline.diff(opened, 'minute')) / 60);
  // tuning constants - prefer values from CONFIG.xpScaling if present
  const cfg = CONFIG.xpScaling || {};
  const k = Number.isFinite(Number(cfg.k)) ? Number(cfg.k) : 6;
  const minMult = Number.isFinite(Number(cfg.minMult)) ? Number(cfg.minMult) : 0.5;
  const maxMult = Number.isFinite(Number(cfg.maxMult)) ? Number(cfg.maxMult) : 3.5;

    let mult = k / hours;
    if (!Number.isFinite(mult) || mult <= 0) mult = 1;
    mult = Math.max(minMult, Math.min(maxMult, mult));
    const xp = Math.max(1, Math.round(baseXp * mult));
    return xp;
  } catch (e) {
    logger.debug({ e, openedAtISO, deadlineISO }, 'xpForProposal failed');
    return baseXp || 10;
  }
}

export default {
  normalizeText,
  isYesToken,
  isNoToken,
  matchStickerHash,
  computeDeadline,
  computeDeadlineFromMinutes,
  isPast,
  humanTimeLeft,
  groupSize,
  summarizeVotes,
  formatToUTCMinus3,
  xpForProposal,
};
