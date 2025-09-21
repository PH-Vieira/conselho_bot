import { forceNotifyNow } from '../../lib/messageCounter.js';
import { jidNormalizedUser } from '@whiskeysockets/baileys';
import CONFIG from '../../lib/config.js';

/**
 * Admin-only command to force the 10-day notifier to run immediately.
 * Usage: !notify-now
 */
export default async function notifyNowCmd(ctx) {
  const { msg, group, sendReply } = ctx;
  const ntext = (msg.message?.conversation || '').trim();
  if (ntext !== '!notify-now') return false;
  // authorize
  const sender = jidNormalizedUser(msg.key.participant || msg.key.remoteJid);
  if (!CONFIG.adminJid || jidNormalizedUser(CONFIG.adminJid) !== sender) {
    await sendReply(group.id, 'ℹ️ Comando restrito. Apenas o administrador pode executar !notify-now.');
    return true;
  }
  try {
    await forceNotifyNow(ctx.sock);
    await sendReply(group.id, '✅ Notificação forçada executada.');
  } catch (e) {
    await sendReply(group.id, '❗ Falha ao executar notificação forçada. Veja logs.');
  }
  return true;
}
