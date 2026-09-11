# Plano técnico — OpenBot agêntico

Derivado do PRD `PRD_OpenBot_Agentico_v1.md` e da auditoria de 11/09/2026, conferidos contra o
código em `current-state.md`. Este documento fixa arquivos, contratos, migrações e riscos antes da
implementação, como pede a seção 22 do prompt.

## 1. Decisões de arquitetura

| ID | Decisão | Motivo |
|---|---|---|
| D-01 | Núcleo novo em `server/src/agent-runs/` (persistência, serviço, rotas) e `server/src/agent-runtime/` (loop, contratos, providers, ferramentas). | Reaproveita Hono/Drizzle/gateway; nenhum segundo navegador. |
| D-02 | O executor roda como loop de fundo no processo do servidor, iniciado no boot, com lease em PostgreSQL. `worker/` ganha entrada que roda o mesmo loop fora do servidor. | Não bloqueia request HTTP; banco como fila (ADR-05); worker hoje não entra na imagem publicada. |
| D-03 | Toda ação de navegador continua pelo `ComputerGateway` existente, em processo, com `ActionActor` estendido com `runId`/`stepId` opcionais. Nada de Playwright direto para o modelo. | Preserva política, auditoria antes da ação e a geração de snapshot. |
| D-04 | Estados cobrem o prompt e o PRD: `queued`, `running`, `waiting_model`, `executing`, `waiting_approval`, `waiting_human`, `paused`, `needs_reconciliation`, `succeeded`, `failed`, `cancelled`. `uncertain` = `needs_reconciliation`; `completed` = `succeeded`. | Um nome para cada fato; sem sinônimos duplicados. |
| D-05 | Dois modos de execução: `step` (o núcleo conduz observar→decidir→agir com providers de API) e `delegated` (Codex conduz o ciclo; o núcleo grava o run e recebe a narrativa). | PRD §5: não empilhar dois planejadores. |
| D-06 | Screenshot vira `ImageArtifact` com classificação, hash, retenção e destinos permitidos; máscaras via `mask` do Playwright configuradas por env. | NFR-05; A06. |
| D-07 | Novas operações semânticas só entram quando um caso P0 exige (`select_option`, `hover`). Abas, upload e download ficam para P1, registrados em `docs/agentic/architecture.md`. | PRD §7.3 limita upload a artefato escolhido pelo operador; o caso TikTok P0 é uma página só. |
| D-08 | Aprovação é linha própria (`run_approvals`) com hash da ação + dados + geração da observação, validade e consumo único. | FR-14. |
| D-09 | Telegram é módulo do servidor com long polling, inbox deduplicada e outbox persistente; nunca fala com o computador direto. | ADR-06; FR-12/22. |
| D-10 | Idempotência por `idempotencyKey` única no run e por `(botId, updateId)` na inbox; ação com resultado incerto não é repetida — vira `needs_reconciliation`. | FR-06/18; NFR-09. |

## 2. Migrações e esquema (Fase 1)

Arquivo novo `server/src/db/schema/agentRuns.ts`, adicionado a `server/drizzle.config.ts`.
Todas as colunas JSONB usam o `jsonb` de `./json.ts`.

| Tabela | Colunas principais | Restrição |
|---|---|---|
| `agent_runs` | id uuid, botId, userId, threadId, origin, sourceMessageId, idempotencyKey único, provider, model, objective, status, currentStep, budget jsonb, usage jsonb, leaseOwner, leaseGeneration, leaseExpiresAt, heartbeatAt, checkpoint jsonb, error jsonb, metadata jsonb, timestamps | `idempotencyKey` única; índice por `(status, createdAt)`; índice por `botId` |
| `agent_run_steps` | id uuid, runId → agent_runs cascade, seq, kind, status, observation jsonb, modelDecision jsonb, proposedAction jsonb, policyDecision jsonb, executionResult jsonb, artifactId, timestamps | único `(runId, seq)` |
| `agent_run_events` | id uuid, runId cascade, seq, type, payload jsonb, createdAt | único `(runId, seq)` |
| `run_artifacts` | id uuid, runId, stepId, kind, mime, width, height, hash, bytes, storagePath, classification, protection, retentionUntil, allowedDestinations text[], metadata jsonb, createdAt | índice por `retentionUntil` |
| `browser_profile_leases` | profileId text pk, runId, owner, generation, acquiredAt, heartbeatAt, expiresAt | uma linha por perfil = uma posse |
| `run_approvals` | id uuid, runId, stepId, actorUserId, actionHash, action jsonb, destination, expectedEffect, status, expiresAt, consumedAt, createdAt | índice por `(runId, status)` |
| `model_configurations` | id text pk, provider, transport, modelId, baseUrl, credentialId, capabilities jsonb, limits jsonb, enabled, testedAt, timestamps | semente a partir do env |
| `telegram_bindings` | id uuid, telegramUserId text, chatId text, userId, botId, permissions jsonb, createdAt | único `(telegramUserId, chatId)` |
| `telegram_pairing_codes` | code text pk, userId, botId, createdAt, expiresAt, consumedAt | consumo único |
| `telegram_inbox` | id uuid, telegramBotId, updateId bigint, payload jsonb, receivedAt, processedAt, error | único `(telegramBotId, updateId)` |
| `notification_outbox` | id uuid, runId, channel, destination jsonb, eventType, dedupeKey, payload jsonb, attempts, nextAttemptAt, deliveredAt, lastError, createdAt | único `(channel, dedupeKey)` |

Enums: `agent_run_status`, `agent_run_origin`, `agent_run_step_kind`, `artifact_classification`,
`artifact_protection`, `approval_status`, `notification_channel`.

Comandos: `cd server && bun run db:generate && bun run db:migrate` (contra o banco configurado).

## 3. Contratos do runtime (Fase 2)

`server/src/agent-runtime/contracts.ts`:

```ts
export interface AgentModelProvider {
  id: string;
  capabilities: { vision: boolean; tools: boolean; streaming: boolean; mode: "step" | "delegated" };
  run(input: AgentRunInput, context: AgentRunContext): Promise<AgentRunResult>;
}
```

- `AgentObservation`: `observationId`, `runId`, `profile`, `url`, `title`, `text`, `truncated`,
  `elements` (snapshot + `snapshotId`), `viewport`, `capturedAt`, `artifacts` (imagem autorizada com
  metadados), `control` (holder, secret pendente).
- `AgentRunResult`: `{ kind: "tool_call", call } | { kind: "final", message, evidence } |
  { kind: "help", reason } | { kind: "invalid", raw, error } | { kind: "delegated_summary", ... }`.
- `ToolCatalog`: definições JSON Schema + executor por nome, resolvido em
  `browser-tools.ts` → `ComputerGateway`.
- Decisão inválida (JSON quebrado, ferramenta inexistente) ganha no máximo 2 correções antes de
  `failed`/`waiting_human` (FR-03, NFR-09).

## 4. Arquivos afetados por fase

### Fase 1 — Tarefas duráveis
- Novo: `server/src/db/schema/agentRuns.ts`, `server/src/agent-runs/{types,repository,service,routes,worker}.ts`
- Alterado: `server/drizzle.config.ts`, `server/src/app.ts` (montar rotas), `server/src/index.ts` (store + worker no boot), `server/src/config.ts` (bloco `agentRuntime`), `server/src/audit.ts` (eventos novos)

### Fase 2 — Runtime
- Novo: `server/src/agent-runtime/{contracts,loop,observation,prompt,registry}.ts`, `server/src/agent-runtime/providers/*`
- Alterado: `server/src/agent-runs/worker.ts` (executor), `config.ts`

### Fase 3 — Ferramentas e visão
- Novo: `server/src/agent-runtime/{browser-tools,image-input,artifact-store,redact}.ts`
- Alterado: `server/src/computer/{schema,gateway}.ts` (atribuição run/step; screenshot com máscaras), `agent-computer/src/index.ts` (máscaras na screenshot; `select_option`, `hover`), `agent-codex/src/mcp-computer.ts` (conteúdo `image` para screenshot e pedido de ajuda), `server/src/audit.ts`

### Fase 4 — Providers
- Novo: `server/src/agent-runtime/providers/{openai-responses,anthropic,openai-compatible,codex-cli}.ts`
- Alterado: `config.ts`, `model_configurations` (semente), `docs/agentic/providers.md`

### Fase 5 — Telegram
- Novo: `server/src/integrations/telegram/{client,inbox,outbox,commands,poller,routes}.ts`
- Alterado: `config.ts` (bloco `telegram`), `app.ts`, `index.ts`, `.env.example`, `docs/agentic/telegram.md`

### Fase 6 — Aprovação e intervenção
- Novo: `server/src/agent-runs/{approvals,sensitive}.ts`
- Alterado: `loop.ts` (transições), `agent-computer` (estado de segredo bloqueia captura), rotas web
  (`app.ts`), Telegram (`commands.ts`), `docs/agentic/security.md`

### Fase 7 — Formulário/TikTok
- Novo: `server/src/agent-runtime/{form-extract}.ts`, fixtures em `server/tests/fixtures/`
- Alterado: `browser-tools.ts` (ferramenta de extração), `docs/agentic/architecture.md`

### Fase 8 — Hardening
- Novo: `docs/agentic/{architecture,providers,tasks,telegram,security,vps}.md`
- Alterado: `lightpanda/Dockerfile` (asset imutável + checksum), `docker-compose.yml` (defaults de
  publicação), `.env.example`, `worker/` smoke

## 5. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Quebrar os 998 testes existentes | Rodar a suíte após cada fase; nada de reforma ampla; adicionar, não repurposar campos. |
| JSONB duplamente serializado | Usar `./json.ts` em toda coluna JSONB (o comentário do arquivo explica o bug). |
| Pool de conexões nos testes | `TEST_POOL` (max 2) como os testes existentes. |
| Loop agêntico escrever com resultado incerto | Intenção persistida antes da ação; após timeout de mutação, `needs_reconciliation`; nunca repetir submit. |
| Visão entregue como texto | Teste de payload por provider + fixture canvas; `capabilities.vision` obrigatórias. |
| Screenshot vazar segredo | Bloqueio durante entrada de segredo; máscaras configuradas; classificação e retenção; Telegram só envia artefato autorizado. |
| Codex CLI é uma segunda fronteira (shell) | Modo `delegated` do Codex continua com as flags atuais; o runtime não promete shell governado; documentado em `security.md`. |
| Duas Tasks no mesmo perfil | `browser_profile_leases` com geração monotônica; segunda task aguarda. |
| Telegram criar execução indevida | Pareamento com código de uso único, chats privados, dedupe por update, allowlist numérica. |
| Migração de esquema em base existente | Migrações só adicionam; nada de remover coluna; rollback documentado por fase. |
| VPS pequena (2 vCPU/4 GB) | Um run de navegador ativo, 40 passos, 15 min, navegador ocioso fecha em 10 min (configurável). |

## 6. Evidência por fase

Cada fase termina com: arquivos alterados, comando executado, resultado real, itens não testados e
riscos novos — no corpo do trabalho. O que depende de VPS, conta TikTok, Telegram real ou modelo pago
fica marcado como **implementado sem homologação**, nunca como concluído operacionalmente.
