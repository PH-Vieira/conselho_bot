import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
import logger from './lib/logger.js';
import CONFIG from './lib/config.js';
import { initDb, db, cleanupPendingSelections } from './lib/db.js';
import registerMessageHandlers from './handlers/messages.js';
import { tickDeadlines } from './lib/votes.js';
import { safePost } from './lib/messaging.js';

async function run() {
  await initDb();
  // Allow configuring where auth files are stored so you can run a separate
  // session for the bot (e.g. a Business number) without overwriting your
  // primary WhatsApp session. Priority: ENV AUTH_DIR > config.authDir > ./auth
  const authDir = process.env.AUTH_DIR || CONFIG.authDir || './auth';
  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  // Optional network/TLS convenience: if configured to allow insecure TLS, set
  // the environment variable so Node will not reject self-signed/proxy CAs.
  if (CONFIG.insecureTls) {
    logger.warn('CONFIG.insecureTls is true — disabling Node TLS certificate verification (NODE_TLS_REJECT_UNAUTHORIZED=0)');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  let sock = null;
  let tickInterval = null;
  let reconnectDelay = 1000; // start with 1s
  let authFailureCount = 0;
  let tlsFailureCount = 0;
  let reconnectAttempts = 0;
  const MAX_RECONNECT_ATTEMPTS = 8;
  let unregisterHandlers = null;

  async function startSocket() {
    try {
      sock = makeWASocket({ auth: state, version, logger });

      sock.ev.on('creds.update', saveCreds);

      // Register handlers for this socket (returns an unregister function)
      try {
        unregisterHandlers = registerMessageHandlers(sock);
      } catch (e) {
        logger.warn({ e }, 'registerMessageHandlers failed');
      }

      // Scheduler: ensure only one interval is active
      if (tickInterval) clearInterval(tickInterval);
      tickInterval = setInterval(async () => {
        try {
          await tickDeadlines(sock);
        } catch (err) {
          logger.error({ err }, 'tickDeadlines failed');
        }
      }, 30_000);

      sock.ev.on('connection.update', async (update) => {
        logger.info({ update }, 'conn.update (full)');
        const { qr, connection, lastDisconnect } = update;
        if (qr) {
          // Try to render QR in terminal using qrcode-terminal if installed
          try {
            const mod = await import('qrcode-terminal');
            const qrcode = mod && (mod.default || mod);
            if (qrcode && typeof qrcode.generate === 'function') {
              qrcode.generate(qr, { small: true });
            } else if (typeof qrcode === 'function') {
              qrcode(qr, { small: true });
            } else {
              console.log('----- QR CODE -----\n', qr);
              console.log('\nTip: to render this QR nicely in the terminal install:');
              console.log('  npm install qrcode-terminal');
            }
          } catch (e) {
            console.log('----- QR CODE -----\n', qr);
            console.log('\nTip: to render this QR nicely in the terminal install:');
            console.log('  npm install qrcode-terminal');
            logger.warn({ e }, 'qrcode-terminal import/generate failed');
          }
        }

        if (connection === 'close') {
          logger.warn({ update }, 'connection closed');
          if (lastDisconnect && lastDisconnect.error) logger.warn({ lastDisconnect }, 'lastDisconnect details');
          // If WhatsApp signals the stream was replaced (another session took over),
          // it's better to exit and let the operator decide rather than repeatedly
          // reconnecting and spamming logs. Detect the 'conflict' stream error.
          try {
            const data = lastDisconnect && lastDisconnect.error && lastDisconnect.error.data;
            if (data && data.content && Array.isArray(data.content)) {
              const conflict = data.content.find((c) => c.tag === 'conflict' && c.attrs && c.attrs.type === 'replaced');
              if (conflict) {
                logger.error('WhatsApp stream conflict detected (type=replaced). Another session may have replaced this one.');
                // Try to notify configured admin before exiting, if available
                try {
                  if (CONFIG.adminJid) {
                    await safePost(sock, CONFIG.adminJid, '⚠️ Aviso: o bot detectou que sua sessão foi substituída (conflict type=replaced). O processo vai encerrar para evitar loop de reconexão. Por favor, verifique outras sessão/pareamentos.');
                  }
                } catch (e) {
                  logger.debug({ e }, 'failed to notify admin about replaced conflict');
                }
                try { if (tickInterval) clearInterval(tickInterval); } catch (e) {}
                try { if (sock && sock.end) sock.end(); } catch (e) {}
                process.exit(4);
              }
            }
          } catch (e) {
            logger.debug({ e }, 'error while evaluating lastDisconnect conflict payload');
          }
          // If this was an auth error (401) increment counter and stop after a few attempts.
          const status = lastDisconnect && lastDisconnect.error && lastDisconnect.error.output && lastDisconnect.error.output.statusCode;
          const errCode = lastDisconnect && lastDisconnect.error && lastDisconnect.error.data && lastDisconnect.error.data.code;
          if (status === 401) {
            authFailureCount += 1;
            logger.warn({ authFailureCount }, 'received 401 Unauthorized from WhatsApp server');
            if (authFailureCount >= 3) {
              logger.error('Multiple 401 Unauthorized errors. Your saved credentials are likely invalid for this number.');
              logger.error('To recover: delete or move the auth directory and re-run to scan the QR again.');
              logger.error(`Auth dir in use: ${authDir}`);
              // cleanup interval and socket then exit so user can re-pair
              try { if (tickInterval) clearInterval(tickInterval); } catch (e) {}
              try { if (sock && sock.end) sock.end(); } catch (e) {}
              process.exit(2);
            }
          } else {
            // reset auth failure counter on non-auth errors
            authFailureCount = 0;
          }

          // Detect TLS / certificate failures and stop after a few attempts to avoid tight loop
          if (errCode === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' || errCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || errCode === 'CERT_HAS_EXPIRED') {
            tlsFailureCount += 1;
            logger.warn({ tlsFailureCount, errCode }, 'TLS certificate issue detected when connecting');
            if (tlsFailureCount >= 5) {
              logger.error('Multiple TLS errors detected. This likely indicates a local TLS/proxy issue (corporate proxy, missing root CAs, or NODE_TLS_REJECT_UNAUTHORIZED).');
              logger.error('Possible actions:');
              logger.error('- Ensure your system has up-to-date root certificates.');
              logger.error('- If behind a proxy, set proper proxy environment variables (HTTP_PROXY/HTTPS_PROXY).');
              logger.error('- As a temporary debug only, you can set NODE_TLS_REJECT_UNAUTHORIZED=0 (not recommended for production).');
              try { if (tickInterval) clearInterval(tickInterval); } catch (e) {}
              try { if (sock && sock.end) sock.end(); } catch (e) {}
              process.exit(3);
            }
          } else {
            tlsFailureCount = 0;
          }

          // schedule a reconnect with backoff
          try {
            // remove message handlers for this socket so they aren't duplicated on restart
            if (unregisterHandlers) {
              try {
                unregisterHandlers();
              } catch (er) {
                logger.warn({ er }, 'error unregistering handlers');
              }
              unregisterHandlers = null;
            }

            if (tickInterval) { clearInterval(tickInterval); tickInterval = null; }
            if (sock && sock.end) await sock.end();
          } catch (e) {
            logger.warn({ e }, 'error while closing socket');
          }
          reconnectAttempts += 1;
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            logger.error({ reconnectAttempts }, 'Max reconnect attempts exceeded, will stop retrying');
            try {
              if (CONFIG.adminJid) await safePost(sock, CONFIG.adminJid, `⚠️ Bot excedeu ${MAX_RECONNECT_ATTEMPTS} tentativas de reconexão e vai parar. Verifique o servidor e reinicie manualmente.`);
            } catch (e) {
              logger.debug({ e }, 'failed to notify admin about max reconnects');
            }
            try { if (tickInterval) clearInterval(tickInterval); } catch (e) {}
            try { if (sock && sock.end) sock.end(); } catch (e) {}
            return;
          }

          setTimeout(() => {
            reconnectDelay = Math.min(reconnectDelay * 2, 60_000); // cap at 60s
            startSocket().catch(err => logger.error({ err }, 'reconnect failed'));
          }, reconnectDelay);
        }
      });

      // reset backoff on successful start
      reconnectDelay = 1000;
  reconnectAttempts = 0;

      logger.info('Socket started');
    } catch (err) {
      logger.error({ err }, 'startSocket failed, scheduling reconnect');
      setTimeout(() => startSocket().catch(e => logger.error({ e }, 'reconnect attempt failed')), reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    }
  }

  // initial start
  await startSocket();

  // periodic maintenance: cleanup pending selections every minute
  setInterval(async () => {
    try {
      await db.read();
      cleanupPendingSelections();
      // cleanup expired pending proposals (created by !pauta interactive flow)
      try {
        db.data.pendingProposals = db.data.pendingProposals || {};
        const now = new Date().toISOString();
        for (const [k, v] of Object.entries(db.data.pendingProposals)) {
          if (!v || !v.expiresAtISO || v.expiresAtISO < now) delete db.data.pendingProposals[k];
        }
      } catch (e) {}
      await db.write();
    } catch (e) {
      logger.debug({ e }, 'periodic cleanup failed');
    }
  }, 60_000);

  process.on('SIGINT', async () => {
    logger.info('SIGINT received, saving credentials and exiting');
    try { await saveCreds(); } catch (e) { logger.warn({ e }, 'error saving creds on SIGINT'); }
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    logger.info('SIGTERM received, saving credentials and exiting');
    try { await saveCreds(); } catch (e) { logger.warn({ e }, 'error saving creds on SIGTERM'); }
    process.exit(0);
  });

  logger.info('Bot started');
}

run().catch((err) => {
  logger.fatal({ err }, 'Fatal error in main run()');
  setTimeout(() => process.exit(1), 2000);
});


// ----------------------------------------------------
// NOTAS DE REGRA (ref. ao grupo):
// - Janela: 24h (configurável)
// - Quórum: se, ao final, menos da metade votar, pauta cancelada (pode reabrir)
// - Empate: proponente deve apresentar nova proposta
// - Sigilo: trate isso fora do bot; este código não exporta mensagens
// ----------------------------------------------------
