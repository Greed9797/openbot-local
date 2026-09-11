# Tarefas duráveis

O ciclo de vida de uma tarefa em `server/src/agent-runs/`: estados, lease, idempotência,
passos, orçamento, rotas HTTP e falhas. Implementado sem homologação em ambiente real.

## Máquina de estados

Vocabulário único em `types.ts` (`RUN_STATUSES`) e no enum `agent_run_status`
(`server/src/db/schema/agentRuns.ts`). Só `AgentRunService` e o executor movem estados;
as rotas apenas pedem.

| Estado | Significado |
|---|---|
| `queued` | Admitida, esperando o worker. Ponto de retorno de pausas, retomadas e recuperações limpas |
| `running` | Reivindicada por um worker (`claim` com owner+generation); o executor está no loop |
| `waiting_model` | Chamada de modelo em voo (gravado por `advance("waiting_model")` em `loop.ts` antes de `provider.run`) |
| `executing` | Ferramenta em execução. A tarefa entra aqui por `advance("executing")` imediatamente antes de `tools.execute` (e é a última leitura de estado antes da ação: pausa que chegou durante o modelo deixa o passo `skipped`), e o passo ganha o mesmo status em `finishStep` |
| `waiting_approval` | Ação sensível proposta; linha em `run_approvals` aguardando pessoa. Volta a `queued` com o sim ou o não (`decideApproval`) |
| `waiting_human` | Modelo pediu ajuda (`help`), computador com humano no controle (`HUMAN_CONTROL`) ou segredo pendente (`SECRET_PENDING`). Mensagem da pessoa via `appendMessage` devolve a `queued` |
| `paused` | Pausa pedida por pessoa; só sai por `resume` ou `cancel` |
| `needs_reconciliation` | Efeito externo incerto (checkpoint `effect: "uncertain"`). Só pessoa decide: `resume` com motivo `reconciled` |
| `succeeded` | Decisão `final` (ou `delegated`) do modelo, com mensagem e evidência em `run.final` |
| `failed` | Orçamento estourado (`BUDGET_EXCEEDED`), recusas além do limite (`POLICY_DENIED`), provedor esgotado (`PROVIDER_UNAVAILABLE`), decisão inválida repetida (`INVALID_ACTION`) ou erro interno |
| `cancelled` | Cancelada por pessoa; terminal |

Transições por pessoa (`service.ts`): `PAUSABLE = queued, running, waiting_model,
executing, waiting_approval, waiting_human` → `paused`; `RESUMABLE = paused,
waiting_human, needs_reconciliation` → `queued`; `CANCELLABLE` = todos os não-terminais
→ `cancelled`. `TERMINAL` no worker/loop: `succeeded`, `failed`, `cancelled`.

## Lease e recuperação

- `claim(id, owner, ttlMs)` (`repository.ts`): escrita condicional — só uma réplica detém
  `leaseOwner`/`leaseGeneration`/`leaseExpiresAt`. `owner` é `server:<pid>`.
- Heartbeat a cada 1–2 s (`worker.ts`, `drive()`): `renewLease`; lease perdido aborta o passo.
  Leitura paralela detecta pausa/cancelamento e aborta também.
- Perfil do navegador: `acquireProfileLease`/`renewProfileLease`/`releaseProfileLease` sobre
  `browser_profile_leases` (uma linha por perfil). Conflito devolve a tarefa a `queued`
  com evento `run.queued_for_profile`.
- `service.recoverExpired()` (chamado a cada `tick`): para leases vencidos em
  `running`/`waiting_model`/`executing`, lê o checkpoint — `effect: "uncertain"` vira
  `needs_reconciliation` (motivo `worker_lost_effect_uncertain`), senão volta a `queued`
  (`worker_lost_resumed`). Evento `run.status_changed` + auditoria `agent_run.recovered`.
- Executor que termina sem assentar a tarefa (`worker.ts`, `settleFailure`): se o estado ainda
  é ativo, grava `failed`/`INTERNAL` ("The executor stopped without settling the run").
- Faxina do worker (`housekeeping`, 1/min em `server/src/index.ts`):
  `artifactStore.deleteExpired()` (50 por passagem, `EXPIRY_BATCH`) e
  `expireApprovals` (vencidas viram `expired`, com auditoria `agent_run.recovered`).

## Idempotência

- `idempotencyKey` única em `agent_runs`: `repository.create` insere ou devolve a existente;
  `service.createRun` responde `{ run, created: false }` sem segunda trilha quando a chave já
  existe. Na rota, vem do cabeçalho `idempotency-key` ou do corpo.
- Telegram: `handleIntent` cria a tarefa com `idempotencyKey = telegram:<botId>:<updateId>`
  e `sourceMessageId = messageId`; reentrega da plataforma responde "Essa mensagem já virou
  a tarefa …". A tabela `telegram_inbox` (única por `(telegramBotId, updateId)`) barra antes,
  em `recordUpdate`.

## Passos, eventos, mensagens

- `agent_run_steps`, único `(runId, seq)` via `allocateStep`. `STEP_KINDS`: `observation`,
  `decision`, `action`, `execution`, `note`, `delegated`. O passo guarda `observation`
  (sem texto de página nem base64 — `observationRecord`), `modelDecision`, `proposedAction`,
  `policyDecision`, `executionResult`, `artifactId`. Estados de passo vistos no loop:
  `started`, `skipped`, `invalid`, `refused`, `waiting_approval`, `waiting_human`,
  `executing`, `ok`, `failed`, `uncertain`, `succeeded`.
- `agent_run_events`, único `(runId, seq)`: `run.created`, `run.status_changed`, `run.message`,
  `run.approval_decided`, `run.approval_denied`, `run.final`, `run.note`, `run.screenshot`,
  `run.queued_for_profile`. O histórico que o provedor recebe é um resumo dos últimos 20
  passos (`HISTORY_STEPS`, `historyOf`).
- `agent_run_messages` (conversa com a tarefa): autor `person`/`system`, limite de 4 000
  caracteres (`MESSAGE_LIMIT`), `undeliveredMessages`/`markMessagesDelivered(stepSeq)` —
  a resposta da pessoa entra no próximo `AgentRunInput.messages`. Mensagem para tarefa em
  `waiting_approval` é observação, não sim: só `waiting_human` volta sozinha a `queued`.

## Orçamento

`RunBudget` persistido na criação (`defaults` de `AgentRuntimeConfig` + `input.budget`):

| Limite | Padrão | Origem |
|---|---|---|
| `maxSteps` | 40 | `AGENT_MAX_STEPS` |
| `maxMs` | 900 000 (15 min) | `AGENT_MAX_RUN_MS` |
| `maxCorrections` | 2 | `AGENT_MAX_CORRECTIONS` |

Fixos na montagem do executor (`server/src/index.ts`): `maxRefusals: 2`,
`maxProviderRetries: 1` (espera 500 ms → 4 s entre tentativas). `RunUsage`:
`steps`, `activeMs` (exclui espera por pessoa), `modelCalls`, `toolCalls`.

## Rotas HTTP (`/api/agent-runs`, `requireUser`; visível = dono ou admin)

| Método e caminho | Corpo | Resposta |
|---|---|---|
| `POST /` | `{ objective, botId?, threadId?, provider?, model?, origin?, idempotencyKey?, sourceMessageId? }` + cabeçalho `idempotency-key` | 201 `{ run, created: true }` ou 200 `{ run, created: false }` |
| `GET /?status=&botId=&userId=&limit=` | — | `{ runs }` (limite máx. 200; não-admin só vê os próprios) |
| `GET /:id` | — | `{ run }` |
| `GET /:id/steps` | — | `{ steps }` |
| `GET /:id/events?after=` | — | `{ events }` |
| `GET /:id/events/stream?after=` | — | SSE `text/event-stream` (poll de 1 s; `event: end` em estado terminal) |
| `POST /:id/screenshot` | — | `{ artifact }` (metadados; 503 sem navegador, 502 se a captura falhar) |
| `GET /:id/artifacts/:artifactId` | — | bytes com `content-type` do artefato e `cache-control: no-store`; 404 se o artefato não for da tarefa |
| `POST /:id/messages` | `{ text }` | `{ run }` |
| `GET /:id/messages?after=` | — | `{ messages }` |
| `GET /:id/approvals` | — | `{ approvals }` |
| `POST /:id/approvals/:approvalId` | `{ decision: "approve"\|"deny", note? }` | `{ run, approval }` |
| `POST /:id/pause`, `/resume`, `/cancel` | — | `{ run }` |

Erros: `NOT_FOUND` → 404 (inclusive para tarefa de outro dono, de propósito),
transição inválida → 409, corpo inválido → 400. Auditoria: `agent_run.created`,
`agent_run.status_changed`, `agent_run.completed`, `agent_run.cancelled`,
`agent_run.recovered`, `agent_run.approval_approved`, `agent_run.approval_denied`.

## O que acontece em cada falha

| Falha | Efeito (`RUN_ERROR_CODES`) |
|---|---|
| Provedor não registrado | `failed`/`PROVIDER_UNAVAILABLE` |
| Provedor erro após `maxProviderRetries` | `failed`/`PROVIDER_UNAVAILABLE` |
| Resposta inválida além de `maxCorrections` | `failed`/`INVALID_ACTION` |
| Ref excede geração do snapshot | `stale: true` (`STALE_SNAPSHOT`/`ELEMENT_NOT_FOUND`); o modelo mapeia de novo, não repete |
| Política recusa além de `maxRefusals` (inclui não da pessoa) | `failed`/`POLICY_DENIED` |
| Ação enviada sem confirmação (`ComputerUnavailableError` em ferramenta acting) | `uncertain` → `needs_reconciliation`/`EFFECT_UNCERTAIN`; nunca repetida |
| Humano assumiu / segredo pendente | `waiting_human` (`HUMAN_CONTROL`/`SECRET_PENDING`) |
| Observação falhou | passo `failed`, tarefa `failed`/`INTERNAL` |
| Lease perdido / processo morto | `recoverExpired`: `queued` ou `needs_reconciliation` |
| Orçamento (passos ou tempo) | `failed`/`BUDGET_EXCEEDED` |
