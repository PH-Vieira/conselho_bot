import logger from './logger.js';

export async function post(sock, jid, text) {
  try {
    const res = await sock.sendMessage(jid, { text });
    logger.debug({ jid, text }, 'message.sent');
    return res;
  } catch (err) {
    logger.error({ err, jid, text }, 'failed to send message');
    return null;
  }
}

export async function safePost(sock, jid, text) {
  try {
    const res = await post(sock, jid, text);
    if (!res) {
      logger.warn({ jid, text }, 'safePost: send returned null (possible failure)');
    } else {
      logger.info({ jid, text, msgId: res.key?.id }, 'safePost: message sent');
    }
    return res;
  } catch (err) {
    logger.error({ err, jid, text }, 'safePost: unexpected error');
    return null;
  }
}

export default { post, safePost };
