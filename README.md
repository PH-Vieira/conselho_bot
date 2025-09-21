# 🏛️ Conselho Bot

Bem-vindo ao *Conselho Bot* — um bot simples para conduzir votações em um grupo do WhatsApp com sistema de XP, níveis e pequenas celebrações 🎉.

Este README explica rapidamente como configurar, executar e testar o bot em Windows PowerShell.

---

## ✅ Recursos principais

- Criar pautas: `!pauta <título> [<tempo>]` (ex.: `!pauta Reunião 30m`)
- Votar: `!votar <nome> [sim|nao]` ou apenas enviar `sim` / `nao` na conversa
- Pautas por figurinha (sticker) — stickers podem representar sim/nao ou travar voto
- XP e níveis: usuários ganham XP ao votar (uma vez por pauta). XP é escalado por duração da pauta (pautas curtas dão mais XP).
- Comandos sociais: `!me` (seu perfil), `!ranking` (maiores votantes)

---

## 🛠️ Requisitos

- Node.js 18+ (recomendado)
- Windows PowerShell (os comandos abaixo são para PowerShell)

---

## ⚙️ Configuração

1. Crie um `config.json` na raiz do projeto copiando `config.example.json`:

```powershell
cp .\config.example.json .\config.json
# edite .\config.json com seu editor de texto (groupJid, stickers, etc.)
```

2. Ajuste os valores importantes em `config.json`:
- `groupJid` ou `groupName` — identifique seu grupo
- `voteWindowHours` — padrão de duração
- `stickers` — hashes das figurinas para representar sim/nao/council
- `xpPerVote` — XP base por voto (padrão no exemplo: 10). Você pode aumentar para 25, etc.
- `xpScaling` — parâmetros opcionais que controlam como a duração da pauta afeta o XP (k, minMult, maxMult)

---

## ▶ Executando o bot (PowerShell)

No diretório do projeto:

```powershell
# instalar dependências (se houver package.json)
npm install

# rodar
$env:LOG_LEVEL = 'info'; node .\index.js
# ou apenas
node .\index.js
```

Se o bot travar por problemas de sessão (conta emparelhada em outro local), verifique logs e reinicie.

---

## 🔍 Testes simples no grupo

- Crie uma pauta: `!pauta Teste XP 30m`
- Vote com `sim`/`nao` ou `!votar Teste XP sim`
- Verifique seu perfil com `!me` (verá XP, nível e progresso)
- Veja o ranking com `!ranking`

---

## 🧩 Arquitetura / Onde editar

- `index.js` — inicializa o cliente e o loop do bot
- `handlers/messages.js` — regras de comandos e parsing de mensagens
- `lib/helpers.js` — utilitários, formatação de tempo, XP e níveis
- `lib/db.js` — persistência (lowdb / data.json)
- `config.json` — configuração de ambiente e parâmetros do bot

---

## 💡 Ideias para personalizar

- Ajuste `xpPerVote` e `xpScaling` no `config.json` para controlar a gamificação
- Mude `COUNCIL_TITLES` em `lib/helpers.js` para títulos temáticos
- Adicione mais frases/emoções no bot em `handlers/messages.js` (tem `pickRandom` e `EMOJI_POOLS` prontos)

---

## 🆘 Problemas comuns

- Missing `config.json` → copie o exemplo e preencha
- `lastDisconnect` / sessão substituída → verifique `CONFIG.adminJid` e logs

---

Divirta-se! ⚖️✨
