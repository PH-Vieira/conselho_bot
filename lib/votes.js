import { db } from './db.js';
import { summarizeVotes, groupSize, formatToUTCMinus3 } from './helpers.js';
import { safePost } from './messaging.js';
import CONFIG from './config.js';

export async function evaluateProposal(sock, proposal) {
  const { groupJid, id } = proposal;
  const size = await groupSize(sock, groupJid);
  const { yes, no } = summarizeVotes(proposal.votes);
  const voters = yes + no;
  // Determine approval rule: per-proposal `approval` takes precedence.
  const approval = proposal.approval || null;
  if (approval && approval.type === 'unanimity') {
    // unanimity: all participants must vote yes (or at least all voters must be yes?)
    // We'll require that every group participant who voted must be yes AND that voters === size (everyone voted yes).
    if (yes === size && no === 0) {
      proposal.status = 'aprovada';
      await db.write();
      const fmt = formatToUTCMinus3(proposal.deadlineISO);
      await safePost(sock, groupJid, `🏁 Pauta *${proposal.title}* *APROVADA* por unanimidade (✅ ${yes} | ❌ ${no}). Prazo expirou em ${fmt}.`);
      return;
    }
    // otherwise it's rejected (or tied) — treat as rejected unless all yes
    proposal.status = 'rejeitada';
    await db.write();
    const fmt = formatToUTCMinus3(proposal.deadlineISO);
    await safePost(sock, groupJid, `🏁 Pauta *${proposal.title}* *REJEITADA* (não atingiu unanimidade). Resultado: ✅ ${yes} | ❌ ${no}. Prazo expirou em ${fmt}.`);
    return;
  }

  // quorum by percentage (default behavior)
  let quorumPercent = null;
  if (approval && approval.type === 'quorum' && typeof approval.quorumPercent === 'number') {
    quorumPercent = approval.quorumPercent;
  } else if (CONFIG.quorumRule === 'half') {
    quorumPercent = 0.5; // half of members
  }

  if (quorumPercent) {
    const needed = Math.ceil(size * quorumPercent);
    if (voters < needed) {
      proposal.status = 'cancelled';
      await db.write();
      const fmt = formatToUTCMinus3(proposal.deadlineISO);
      await safePost(sock, groupJid, `🚫 Pauta *${proposal.title}* cancelada por falta de quórum (${voters}/${size} — necessário ${needed}). Prazo expirou em ${fmt}. Pode ser reaberta.`);
      return;
    }
  }

  if (yes === no) {
    proposal.status = 'tied';
    await db.write();
    const fmt = formatToUTCMinus3(proposal.deadlineISO);
    await safePost(sock, groupJid, `⚖️ Pauta *${proposal.title}* empatada (${yes} x ${no}). Prazo expirou em ${fmt}. O proponente deve apresentar nova proposição.`);
    return;
  }

  const result = yes > no ? 'APROVADA' : 'REJEITADA';
  proposal.status = result.toLowerCase();
  await db.write();
  const fmt = formatToUTCMinus3(proposal.deadlineISO);
  await safePost(sock, groupJid, `🏁 Pauta *${proposal.title}* *${result}*. Resultado final: ✅ ${yes} | ❌ ${no}. Prazo expirou em ${fmt}.`);
  return;
}

export async function tickDeadlines(sock) {
  const open = (db.data.proposals || []).filter((p) => p.status === 'open');
  for (const p of open) {
    if (new Date() > new Date(p.deadlineISO)) {
      await evaluateProposal(sock, p);
    }
  }
}

export default { evaluateProposal, tickDeadlines };
