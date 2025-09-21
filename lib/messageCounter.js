import { db } from './db.js';
import CONFIG from './config.js';
import logger from './logger.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import { safePost } from './messaging.js';

const TEN_DAYS_MS = 10 * 24 * 60 * 60 * 1000;

/**
 * Ensure the shape for messageCounter exists in DB
 */
async function ensureMessageCounter() {
  await db.read();
  db.data = db.data || {};
  db.data.messageCounter = db.data.messageCounter || { lastNotifyISO: null, counts: {} };
  db.data.messageCounter.counts = db.data.messageCounter.counts || {};
}

/**
 * Increment message count for a given group and user JID.
 * Only stores counts per-group so multiple groups don't interfere.
 */
export async function incrementGroupMessageCount(groupId, userJid) {
  try {
    await ensureMessageCounter();
    const norm = jidNormalizedUser(userJid);
    db.data.messageCounter.counts[groupId] = db.data.messageCounter.counts[groupId] || {};
    db.data.messageCounter.counts[groupId][norm] = (db.data.messageCounter.counts[groupId][norm] || 0) + 1;
    await db.write();
  } catch (e) {
    logger.debug({ e, groupId, userJid }, 'incrementGroupMessageCount failed');
  }
}

/**
 * Compute the least-active participant in a group based on counts stored.
 * Returns an object { jid, count, displayName } or null if none.
 */
async function computeLeastActive(sock, groupId) {
  try {
    await ensureMessageCounter();
    const countsForGroup = db.data.messageCounter.counts[groupId] || {};
    if (!CONFIG.groupJid || CONFIG.groupJid !== groupId) {
      // operate only on configured group
    }
    // fetch group metadata to get participants
    let meta = null;
    try {
      meta = await sock.groupMetadata(groupId);
    } catch (e) {
      logger.debug({ e, groupId }, 'computeLeastActive: failed to fetch group metadata');
      return null;
    }
    const parts = (meta && meta.participants) ? meta.participants.map((p) => p.id) : [];
    if (parts.length === 0) return null;
    let minJid = null;
    let minCount = Infinity;
    for (const p of parts) {
      const norm = jidNormalizedUser(p);
      const c = countsForGroup[norm] || 0;
      if (c < minCount) {
        minCount = c;
        minJid = norm;
      }
    }
    if (!minJid) return null;
    // resolve display name preference: db user name -> participant name -> jid local
    const dbUser = (db.data.users && db.data.users[minJid]) ? db.data.users[minJid] : null;
    let display = dbUser && dbUser.name ? dbUser.name : null;
    try {
      const part = (meta && meta.participants) ? (meta.participants.find((p) => p.id === minJid) || null) : null;
      if (!display && part) display = part.name || part.notify || part.pushname || null;
    } catch (e) {}
    if (!display) display = minJid.split('@')[0];
    return { jid: minJid, count: minCount, displayName: display };
  } catch (e) {
    logger.debug({ e, groupId }, 'computeLeastActive failed');
    return null;
  }
}

/**
 * Run the notification: post to group and notify admin, then reset counts for that group.
 */
async function runNotify(sock, groupId) {
  try {
    const who = await computeLeastActive(sock, groupId);
    if (!who) {
      logger.info({ groupId }, 'runNotify: no candidate found to notify');
      return;
    }
    const msg = `⏰ Relatório de atividade (últimos 10 dias): *${who.displayName}* enviou o menor número de mensagens no grupo: ${who.count} mensagens. Conselho, por favor verifiquem.`;
    try {
      await safePost(sock, groupId, msg);
    } catch (e) {
      logger.debug({ e, groupId }, 'failed to send group notify');
    }
    // notify admin if configured
    if (CONFIG.adminJid) {
      try {
        await safePost(sock, CONFIG.adminJid, `🔔 Aviso automático: ${who.displayName} (${who.jid}) foi identificado como o menos ativo no grupo (${who.count} msgs nos últimos 10 dias).`);
      } catch (e) {
        logger.debug({ e }, 'failed to notify admin about least-active user');
      }
    }
    // reset counts for this group and update lastNotifyISO
    await db.read();
    db.data.messageCounter = db.data.messageCounter || { counts: {} };
    db.data.messageCounter.counts[groupId] = {};
    db.data.messageCounter.lastNotifyISO = new Date().toISOString();
    await db.write();
  } catch (e) {
    logger.debug({ e, groupId }, 'runNotify failed');
  }
}

/**
 * Start a periodic checker that triggers a notify every 10 days.
 * Returns a function to stop the interval.
 */
export function startMessageNotifier(sock) {
  // ensure messageCounter exists and set baseline if missing
  (async () => {
    await ensureMessageCounter();
    if (!db.data.messageCounter.lastNotifyISO) {
      db.data.messageCounter.lastNotifyISO = new Date().toISOString();
      await db.write();
      logger.info('messageCounter: initialized lastNotifyISO (first run will occur after 10 days)');
    }
  })().catch((e) => logger.debug({ e }, 'startMessageNotifier init failed'));

  const hour = 60 * 60 * 1000;
  const handle = setInterval(async () => {
    try {
      await db.read();
      const last = db.data.messageCounter && db.data.messageCounter.lastNotifyISO ? new Date(db.data.messageCounter.lastNotifyISO).getTime() : 0;
      const now = Date.now();
      if (!CONFIG.groupJid) return; // nothing to do without configured group
      if (!last || (now - last) >= TEN_DAYS_MS) {
        await runNotify(sock, CONFIG.groupJid);
      }
    } catch (e) {
      logger.debug({ e }, 'messageNotifier periodic check failed');
    }
  }, hour);

  return () => clearInterval(handle);
}

/**
 * Force a notification run immediately (useful for tests).
 */
export async function forceNotifyNow(sock) {
  if (!CONFIG.groupJid) return null;
  return runNotify(sock, CONFIG.groupJid);
}
