export default async function pautas(ctx) {
  const { ntext, sendReply, group, db } = ctx;
  if (ntext !== '!pautas') return false;
  try {
    const list = (db.data.proposals || []).filter((p) => p.groupJid === group.id).slice(-12).reverse();
    if (!list || list.length === 0) {
      await sendReply(group.id, 'ℹ️ Nenhuma pauta registrada ainda.');
      return true;
    }
    const lines = list.map((p) => {
      const status = p.status === 'open' ? 'aberta' : 'fechada';
      let rule = '';
      if (p.approval) {
        if (p.approval.type === 'unanimity') rule = ' — Criticidade: Alta (Unanimidade)';
        else if (p.approval.type === 'quorum') rule = ` — Criticidade: Quorum ${Math.round((p.approval.quorumPercent||0)*100)}%`;
      }
      return `• ${p.id} — ${p.title.length > 60 ? p.title.slice(0, 57) + '...' : p.title} (${status})${rule}`;
    });
    await sendReply(group.id, `📜 Últimas pautas:
${lines.join('\n')}`);
  } catch (e) {
    await sendReply(group.id, '❗ Falha ao listar pautas. Veja os logs.');
  }
  return true;
}
