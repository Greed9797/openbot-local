# Telegram

O canal em `server/src/telegram/`: long polling, inbox deduplicada, outbox com tentativas,
pareamento, comandos e aprovações por botão. Implementado sem homologação com Telegram
real (sem token, sem conta, sem bot de verdade — caminho exercitado com `fetchImpl`
injetável e sem rede).

## Arquitetura do canal

O Telegram nunca fala com o computador direto: toda ação passa pelo mesmo
`AgentRunService` da web, e a tarefa criada por mensagem aparece no painel com o mesmo
estado e trilha. Peças (`server/src/index.ts`): `createTelegramStore`,
`createTelegramClient`, `createTelegramHandler`, `createTelegramPoller`,
`createTelegramSender`, `createTelegramNotifier` (o `RunNotifier` do executor).
Só sobe com `TELEGRAM_BOT_TOKEN` **e** runtime ligado; sem token, nada de polling nem
rotas de pareamento. E só na réplica com o worker (`AGENT_WORKER_ENABLED`): responder
cria tarefas, e um processo sem fila as deixaria paradas.

## Long polling (`poller.ts`)

- `getUpdates` com `POLL_TIMEOUT_SECONDS = 25` (`TELEGRAM_POLL_SECONDS`), `offset` saído
  da própria tabela (`lastUpdateId`): o que já está gravado não é pedido de novo.
  `ERROR_BACKOFF_MS = 5_000` quando a plataforma falha.
- `drain(20)` trata o que ficou pendente de execução anterior antes de pedir coisa nova.
- Cada update: `recordUpdate` grava **antes** de tratar; `handler.handle` decide;
  o poller envia as respostas (`send`: texto, foto ou `answerCallback`).
- Falha no tratamento é registrada com o erro (`markProcessed(id, error)`) e **não** é
  tentada de novo sozinha: mensagem que derruba o manipulador derrubaria de novo; o lugar
  de descobrir isso é a tabela.

## Inbox deduplicada e outbox com tentativas

- `telegram_inbox`, única por `(telegramBotId, updateId)`: `recordUpdate` devolve nada
  quando o update já existe — a plataforma reentrega o não-confirmado, e sem o registro a
  mesma frase viraria duas tarefas.
- `notification_outbox`, única por `(channel, dedupeKey)`: o executor anuncia
  (`statusChanged`) e volta ao trabalho; a entrega é outro laço. `dedupeKey` =
  `run:<runId>:<estado>[:<approvalId>]:<sha256 do texto>[:<chatId>]`, de modo que repetir
  o mesmo estado (lease perdido, restart) não repete a frase.
- `createTelegramSender`: `claimNotifications` (lote `CLAIM_LIMIT = 20`, lease
  `LEASE_MS = 60 000`), intervalo `TELEGRAM_DELIVERY_INTERVAL_SECONDS` (padrão 5 s),
  `backoffFor` de 2 s dobrando até o teto `MAX_BACKOFF_MS = 15 min`; 429 com `retry_after`
  é respeitado. `GIVE_UP_AFTER_HOURS = 24` (`notifier.ts`) alonga a espera após um dia.
- Só estados de decisão ou fim notificam (`STATUS_PT`): `waiting_approval`,
  `waiting_human`, `needs_reconciliation`, `succeeded`, `failed`, `cancelled`, `paused`.

## Pareamento e allowlist

- Ligar um chat é pelo painel: `POST /api/telegram/pairing-codes` (`routes.ts`) com
  `{ botId }` gera código de 8 caracteres (`ALPHABET` sem confusões, `crypto.getRandomValues`),
  validade `PAIRING_TTL_MS = 15 min`, em `telegram_pairing_codes`.
- No Telegram: `/start CODIGO` (intenção `pair`) → `consumePairingCode` (uso único; código
  gasto ou vencido responde "Esse código não vale mais") → `upsertBinding`
  (`telegramUserId`, `chatId`, `userId`, `botId`; único `(telegramUserId, chatId)`).
- `TELEGRAM_ALLOWED_USER_IDS`: ids **numéricos** (não `@usuario`, que é trocável).
  Lista vazia = **ninguém**: o bot responde com recusa — o padrão seguro de variável
  esquecida. Vale junto o vínculo: a lista diz quem pode falar, o vínculo diz quem a
  pessoa é neste deployment (qual `userId`/`botId` ela opera).
- Desligar: `DELETE /api/telegram/bindings/:id`, só o dono (`bindingsForUser`); listar:
  `GET /api/telegram/bindings`.

## Comandos e linguagem natural (`commands.ts`, `intentOf`)

| Comando | Intenção |
|---|---|
| `/start CODIGO` / `/ajuda`, `/help` | `pair` / `help` |
| `/status` | `status` (tarefa atual + último passo + botão "Ver tela") |
| `/tarefas`, `/tasks` | `tasks` (últimas 8, `TASK_LIST_LIMIT`) |
| `/tela [id]` | `screen` |
| `/analisar [id]` | `analyze` |
| `/pausar [id]`, `/continuar [id] [nota]`, `/cancelar [id]` | `pause` / `resume` / `cancel` |
| `/aprovar <tarefa> <aprovação>`, `/recusar <tarefa> <aprovação> [motivo]` | `approve` / `deny` (sem os dois ids, cai em `tasks`) |

Sem comando, vale a linguagem natural: `SCREEN` (tela|screenshot|captura|print|imagem da
página) + `SCREEN_VERB` (manda|mostra|quero|ver…) → `screen`; `ANALYZE`
(analisa|descreva|o que está aparecendo|…​) + menção a tela/captura/imagem → `analyze`
com a frase como pergunta; qualquer outro texto vira `task` com o texto como objetivo.
`runIdIn` extrai o id da tarefa da frase. A tarefa atual (`currentRun`) é a viva
(`ACTIVE_STATUSES`) ou a última; `runId` explícito só vale se for do mesmo `userId`/`botId`
do vínculo.

## `/tela` sem modelo × `/analisar` com modelo

- `/tela` (`screen` em `handler.ts`): `captureRunScreen` + leitura do artefato, **zero
  chamada de modelo** — é a mesma rota lógica de `POST /:id/screenshot`. Se
  `allowedDestinations` não inclui `"telegram"`, o chat recebe o motivo em vez da foto.
- `/analisar` (`analyze`): escolhe `visionProvider` (primeiro com visão na ordem do
  deployment), captura, `imageForModel` (barrado → `refusalReason` no chat), e
  `analyzeImage` responde. Sem modelo com visão: a mensagem de `NoVisionModelError`.

## Botões de aprovação

Callback `data` carrega `ação:tarefa:aprovação` (`screen:`, `approve:`, `deny:` — o limite
de 64 bytes da plataforma é o motivo; `callbackIntent` revalida e o servidor decide de
novo — botão é atalho, não autorização). A notificação de `waiting_approval` leva
"Ver tela" + "Aprovar" + "Recusar" com ação, `expectedEffect` e `destination`; a decisão
usa `runs.decideApproval` e responde "Aprovada/Recusada: … A tarefa continua." (o não
também reenfileira — o modelo lê a recusa e decide outra coisa).

## Captura sensível não sai no chat

Regra única, igual à do painel (`captureRunScreen` + `image-input.ts`): página em
`AGENT_SENSITIVE_HOSTS` → classificação `sensitive`, destinos só `panel`; `/tela`
responde que a captura ficou guardada para o painel. Artefato `secret` nunca vai a
modelo nenhum. Durante entrada de segredo (`secretWanted`), nem a captura é tirada.
