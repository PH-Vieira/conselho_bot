export default async function contagem(ctx) {
  const { ntext, sendReply, group, db } = ctx;
  if (ntext !== '!contagem') return false;
  // show counts for the most recent open proposal in this group
  const target = (db.data.proposals || []).filter((p) => p.groupJid === group.id && p.status === 'open').slice(-1)[0];
  if (!target) {
    await sendReply(group.id, 'ℹ️ Não há pautas abertas no momento.');
    return true;
  }
  const yes = Object.values(target.votes || {}).filter((v) => (v && typeof v === 'object' ? v.vote === 'yes' : v === 'yes')).length;
  const no = Object.values(target.votes || {}).filter((v) => (v && typeof v === 'object' ? v.vote === 'no' : v === 'no')).length;
  const locked = Object.values(target.votes || {}).filter((v) => (v && typeof v === 'object' ? !!v.final : false)).length;
  const left = (typeof ctx.helpers.humanTimeLeft === 'function') ? ctx.helpers.humanTimeLeft(target.deadlineISO) : '';
  const fmt = (typeof ctx.helpers.formatToUTCMinus3 === 'function') ? ctx.helpers.formatToUTCMinus3(target.deadlineISO) : target.deadlineISO;
  await sendReply(group.id, `📊 Pauta: *${target.title}* (id: ${target.id})\n✔️ Sim: ${yes} — ❌ Não: ${no} — 🔒 Travados: ${locked}\n⏳ Prazo: ${left} (até ${fmt})`);
  return true;
}
