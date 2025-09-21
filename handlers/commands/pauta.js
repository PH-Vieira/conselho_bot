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
  // Handle interactive confirmation for pending proposals: user replies '1','2' or '3'
  const voterId = ctx.jidNormalizedUser(ctx.msg.key.participant || ctx.msg.key.remoteJid);
  await db.read();
  db.data.pendingProposals = db.data.pendingProposals || {};
  const pending = db.data.pendingProposals[voterId] || null;
  if (!ntext.startsWith('!pauta ')) {
    // If user has a pending proposal and replied with a single digit 1..3, finalize it
    if (pending && /^[1-3]$/.test(ntext.trim())) {
      const choice = Number(ntext.trim());
      // map choice to approval rule
      let approval = { type: 'quorum', quorumPercent: 0.25 };
      if (choice === 1) approval = { type: 'quorum', quorumPercent: 0.25 };
      else if (choice === 2) approval = { type: 'quorum', quorumPercent: 0.5 };
      else if (choice === 3) approval = { type: 'unanimity' };
      try {
        const p = pending.proposal;
        p.approval = approval;
        p.status = 'open';
        db.data.proposals = db.data.proposals || [];
        db.data.proposals.push(p);
        // cleanup pending entry
        delete db.data.pendingProposals[voterId];
        await db.write();
        await sendReply(group.id, `✅ Pauta criada com criticidade selecionada: *${p.title}* (id: ${p.id}). Regra de aprovação: ${approval.type === 'unanimity' ? 'Unanimidade' : `quórum ${Math.round(approval.quorumPercent * 100)}%`}. Use !votar ${p.id} sim/nao para votar.`);
      } catch (e) {
        logger.error({ e, voterId, pending }, 'failed to finalize pending pauta');
        await sendReply(group.id, '❗ Falha ao criar pauta. Tente novamente.');
      }
      return true;
    }
    return false;
  }
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
  // create a pending proposal and ask author to choose criticidade
  const pendingObj = {
    proposal: {
      id,
      title,
      openedBy: sender,
      groupJid: group.id,
      openedAtISO,
      deadlineISO,
      votes: {},
      status: 'pending'
    },
    expiresAtISO: new Date(Date.now() + (10 * 60 * 1000)).toISOString() // 10 minutes TTL
  };
  db.data.pendingProposals[voterId] = pendingObj;
  await db.write();
  const opt = [];
  opt.push('Escolha a criticidade desta pauta respondendo com o número correspondente (1, 2 ou 3):');
  opt.push('1) Baixa — exige menos votos (quórum: 25%)');
  opt.push('2) Média — exige mais votos (quórum: 50%)');
  opt.push('3) Alta — exige unanimidade (todos devem concordar)');
  opt.push('Esta escolha expira em 10 minutos.');
  await sendReply(group.id, `📝 Criando pauta: *${title}*
${opt.join('\n')}`);
  return true;
}
