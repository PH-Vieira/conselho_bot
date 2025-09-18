import { db } from './db.js';
import { summarizeVotes, groupSize, formatToUTCMinus3 } from './helpers.js';
import { safePost } from './messaging.js';
import CONFIG from './config.js';

export async function evaluateProposal(sock, proposal) {
  const { groupJid, id } = proposal;
  const size = await groupSize(sock, groupJid);
  const { yes, no } = summarizeVotes(proposal.votes);
  const voters = yes + no;
  const halfNeeded = Math.ceil(size / 2);

  if (CONFIG.quorumRule === 'half' && voters < halfNeeded) {
    proposal.status = 'cancelled';
    await db.write();
    const fmt = formatToUTCMinus3(proposal.deadlineISO);
    await safePost(
      sock,
      groupJid,
      `🚫 Pauta *${proposal.title}* cancelada por falta de quórum (${voters}/${size}). Prazo expirou em ${fmt}. Pode ser reaberta.`
    );
    return;
  }

  if (yes === no) {
    proposal.status = 'tied';
    await db.write();
    const fmt = formatToUTCMinus3(proposal.deadlineISO);
    await safePost(
      sock,
      groupJid,
      `⚖️ Pauta *${proposal.title}* empatada (${yes} x ${no}). Prazo expirou em ${fmt}. O proponente deve apresentar nova proposição.`
    );
    return;
  }

  const result = yes > no ? 'APROVADA' : 'REJEITADA';
  proposal.status = result.toLowerCase();
  await db.write();
  const fmt = formatToUTCMinus3(proposal.deadlineISO);
  await safePost(
    sock,
    groupJid,
    `🏁 Pauta *${proposal.title}* *${result}*. Resultado final: ✅ ${yes} | ❌ ${no}. Prazo expirou em ${fmt}.`
  );
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
