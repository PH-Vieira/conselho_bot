/**
 * Handle the `!help` command and send a short list of available commands.
 *
 * Expected `ctx` properties:
 * - `ntext`: normalized text used to match the command
 * - `sendReply`: helper to reply in DM or group depending on origin
 * - `group`: group metadata used to determine reply destination
 *
 * Behavior:
 * - Returns `false` when the message is not `!help`.
 * - Sends a concise help message and returns `true` when handled.
 */
export default async function help(ctx) {
  const { ntext, sendReply, group } = ctx;
  if (ntext !== '!help') return false;
  const helpMsg = [];
  helpMsg.push('🛠️ Conselho de Pautas — comandos principais:');
  helpMsg.push('');
  helpMsg.push('• !pauta <título> [<tempo>] — criar nova pauta (ex.: !pauta Reunião 48h)');
  helpMsg.push('• !votar <id|nome> [sim|nao] — votar (use !votar <nome> para confirmar antes)');
  helpMsg.push('• Envie "sim"/"nao" ou ✅/❌ — votar na pauta mais recente');
  helpMsg.push('• Envie a figurinha do Conselho — trava seu voto (finaliza)');
  helpMsg.push('');
  helpMsg.push('• !contagem — mostrar votos e prazo da pauta atual');
  helpMsg.push('• !pautas — listar pautas recentes');
  helpMsg.push('• !me — ver seu nível, XP e votos registrados');
  helpMsg.push('• !ranking — ver os maiores votantes (usa JID se nenhum nome salvo) — funciona em grupo ou via DM se `groupJid` estiver configurado');
  helpMsg.push('• !setnome <seu nome> — definir nome exibido no ranking (funciona em DM)');
  await sendReply(group.id, helpMsg.join('\n'));
  return true;
}
