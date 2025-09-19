import { db, ensureUser } from './db.js';
import logger from './logger.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';

export async function resolveAndPersistName(sock, group, jid, pushName = null) {
  try {
    const norm = jidNormalizedUser(jid);
    ensureUser(norm);
    let current = db.data.users[norm].name || null;
    let resolved = current || pushName || null;

    // try group participants metadata
    try {
      const part = (group && group.participants) ? (group.participants.find((p) => p.id === norm) || null) : null;
      resolved = resolved || part?.name || part?.notify || part?.pushname || null;
    } catch (e) {
      // ignore
    }

    // try socket getName or contacts map
    try {
      if (!resolved && typeof sock.getName === 'function') {
        const n = await sock.getName(norm).catch(() => null);
        if (n) resolved = n;
      }
      if (!resolved && sock.contacts && sock.contacts[norm]) {
        const c = sock.contacts[norm];
        resolved = c.name || c.notify || c.vname || resolved;
      }
    } catch (e) {
      // ignore
    }

    if (resolved && resolved !== db.data.users[norm].name) {
      db.data.users[norm].name = resolved;
      await db.write();
      return { changed: true, name: resolved };
    }
    return { changed: false, name: resolved };
  } catch (e) {
    logger.debug({ e, jid }, 'resolveAndPersistName failed');
    return { changed: false, name: null };
  }
}

export default { resolveAndPersistName };
