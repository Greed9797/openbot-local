# VPS — o que muda no deploy

O runtime agêntico no deployment real: variáveis, volumes, worker, consumo, migrações e
conferência pós-subida. Implementado sem homologação em VPS real.

## Variáveis novas (`.env.example`, seção "Tarefas duráveis" + "Telegram")

| Variável | Padrão | Efeito |
|---|---|---|
| `AGENT_RUNTIME_ENABLED` | on | Desligado desmonta serviço, worker e rotas `/api/agent-runs` |
| `AGENT_WORKER_ENABLED` | on | Só a réplica com worker conduz a fila — e só ela sobe poller/sender do Telegram |
| `AGENT_POLL_MS` | 1000 | Intervalo do `tick` do worker |
| `AGENT_LEASE_TTL_MS` | 60000 | TTL do lease da tarefa e do perfil; heartbeat de 1–2 s |
| `AGENT_MAX_STEPS` / `AGENT_MAX_RUN_MS` / `AGENT_MAX_CORRECTIONS` | 40 / 900000 / 2 | Orçamento gravado em cada tarefa |
| `AGENT_OPENAI_API_KEY` (+`_MODEL`, default `gpt-5.5`) | — | Provedor `openai-responses` (`OPENAI_API_KEY` também serve) |
| `AGENT_ANTHROPIC_API_KEY` (+`_MODEL`, default `claude-sonnet-4-5`) | — | Provedor `anthropic` |
| `AGENT_LOCAL_BASE_URL` (+`_MODEL` default `llama3.1`, `_API_KEY`, `_TOOLS` on) | — | Provedor `local` (`/v1/chat/completions`) |
| `AGENT_CODEX_URL` (ou `MANAGED_AGENT_AG_UI_URL`) | — | Provedor `codex` delegado |
| `AGENT_GEMINI_API_KEY` (+`_MODEL` default `gemini-3.8-flash`, `_BASE_URL`) | — | Provedor `gemini` pela API nativa (`GEMINI_API_KEY`/`GOOGLE_API_KEY` também servem) |
| `AGENT_OPENCODE_URL` / `AGENT_MIMO_URL` (+`_MODEL`) | — | Provedores delegados `opencode`/`mimo`, um serviço `agent-cli` cada. Sem a URL o container sobe e ninguém o usa |
| `AGENT_CODEX_VISION` / `AGENT_OPENCODE_VISION` / `AGENT_MIMO_VISION` | on | Se o modelo que roda dentro do CLI enxerga imagem. Decisão do deployment: negue para um CLI de texto, senão todo passo pede captura |
| `AGENT_CLI` / `AGENT_CLI_MODEL` / `AGENT_CLI_AUTH_JSON` / `AGENT_CLI_TURN_TIMEOUT_MS` / `CLI_BOT_PORT` | `opencode` / — / — / 900000 / 4210 | Lidos pelo serviço **agent-cli**, não pelo runtime: qual CLI ele dirige, o modelo, a conta em base64, o teto do turno e a porta publicada |
| `AGENT_DEFAULT_PROVIDER` / `AGENT_DEFAULT_MODEL` | primeiro configurado | Explícito e ausente = boot recusado |
| `AGENT_VISION_PROVIDERS` / `AGENT_TEXT_ONLY_PROVIDERS` | presunção por nome | Correção da capacidade de visão até o teste de canvas |
| `AGENT_ARTIFACTS_DIR` | `./.artifacts` (no compose: `/app/.artifacts`) | Onde ficam as capturas |
| `AGENT_ARTIFACT_RETENTION_DAYS` | 7 | Retenção por linha de artefato |
| `AGENT_SENSITIVE_HOSTS` | vazio | Hosts cuja captura fica só no painel |
| `SCREENSHOT_MASK_SELECTORS` | só senhas | Lido pelo **agent-computer**, não pelo servidor |
| `AGENT_APPROVAL_TTL_MINUTES` / `AGENT_APPROVAL_PATTERNS` | 30 / vazio | Validade do sim; termos sensíveis da operação |
| `AGENT_WAITING_HUMAN_MINUTES` / `AGENT_IDLE_BROWSER_MINUTES` | 15 / 10 | Janelas configuradas em `AgentRuntimeConfig` |
| `TELEGRAM_BOT_TOKEN` | — | Sem ele, o canal inteiro não sobe |
| `TELEGRAM_ALLOWED_USER_IDS` | vazio (= ninguém) | Ids numéricos autorizados |
| `TELEGRAM_BOT_ID` / `TELEGRAM_POLL_SECONDS` / `TELEGRAM_DELIVERY_INTERVAL_SECONDS` | `default` / 25 / 5 | Identidade nas tabelas; long polling; outbox |

Sem modelo nenhum configurado o servidor sobe e avisa ("Nenhum modelo está configurado…"):
as tarefas falham com `PROVIDER_UNAVAILABLE`, dito assim.

## Volumes e artefatos

- `agent-artifacts:/app/.artifacts` (`docker-compose.yml`, serviço `openbot`): sem o volume,
  `./.artifacts` vive no sistema efêmero e um `up --build` apaga as evidências que a
  retenção por linha promete guardar. Um volume novo herda o dono do diretório da imagem, e é
  por isso que o `Dockerfile` cria `/app/.artifacts` como `pwuser` — sem esse `chown` o volume
  nasceria de root e a API, que roda como `pwuser`, falharia a primeira captura com EACCES.
  O código não faz `chmod` próprio: grava 0600 em diretório 0700.
- Migrações do Postgres (`server/drizzle/`): o serviço `migrate` do compose
  (`drizzle-kit migrate`) aplica antes de subir. Tabelas novas: `agent_runs`,
  `agent_run_steps`, `agent_run_events`, `run_artifacts`, `agent_run_messages`,
  `browser_profile_leases`, `run_approvals`, `model_configurations`, `telegram_bindings`,
  `telegram_pairing_codes`, `telegram_inbox`, `notification_outbox` (+ enums
  `agent_run_status`, `agent_run_origin`, `agent_run_step_kind`,
  `artifact_classification`, `artifact_protection`, `approval_status`,
  `notification_channel`, `run_message_author`). Gerar localmente:
  `cd server && bun run db:generate && bun run db:migrate`. Só adicionam; rollback por
  fase está no plano.

## Um worker por fila

- `AGENT_WORKER_ENABLED=on` em **uma** réplica: duas conduziriam a mesma fila (o lease
  impede corrupção, mas gera contenção e `run.queued_for_profile` à toa).
- O Telegram sobe junto do worker (`server/src/index.ts`): réplica sem worker não tem
  poller nem sender — mensagens virariam tarefas paradas.
- Concorrência fixa em 1 (`concurrency: 1`): um navegador ativo por vez, o número da VPS
  pequena (2 vCPU/4 GB) do plano. Orçamento padrão: 40 passos, 15 min por tarefa.

## Consumo

- Cada passo = 1 observação (snapshot + texto; screenshot só quando o passo anterior
  pediu) + 1 chamada de modelo; espera por pessoa não conta `activeMs`.
- `notification_outbox` e `telegram_inbox` crescem com o uso: linhas de outbox entregues
  saem (`markDelivered`); artefatos saem pela retenção. Nada disso exige cron externo —
  é o `housekeeping` do worker (1/min).

## O que conferir depois de subir

1. Boot sem erro de `AGENT_DEFAULT_PROVIDER` e sem o aviso de zero provedores; `GET
   /api/agent-runs?limit=1` responde (runtime montado).
2. `GET /api/models` lista cada provedor configurado — id, modelo, transporte, `capabilities`
   e qual é o padrão. É aqui que se confere se um serviço recém-subido (um CLI de agente, um
   provedor novo) chegou ao runtime: o que não foi construído não aparece, e um id que
   deveria estar na lista e não está é o defeito que esta conferência existe para pegar.
3. `model_configurations` tem uma linha por provedor configurado, com `testedAt` nulo
   até o teste de canvas (AT-01) — rodá-lo é o que transforma visão presumida em
   homologada.
4. Criar tarefa de fumaça (ex.: "abra example.com e me diga o título"), acompanhar em
   `GET /:id/events/stream` até `succeeded`; conferir passos em `/:id/steps`.
5. Com Telegram: gerar código em `POST /api/telegram/pairing-codes`, `/start CODIGO` no
   privado, `/tela` devolve foto sem gastar modelo; `TELEGRAM_ALLOWED_USER_IDS` com os
   ids certos (vazio = bot que só recusa).
6. `agent-artifacts` com arquivos por tarefa; linhas vencidas sumindo após a retenção.
7. Aprovação: ação sensível (ex. clique em "publicar") estaciona em `waiting_approval`,
   botão "Aprovar" no Telegram conclui, e `run_approvals` mostra a linha `consumed`.
8. Não homologado aqui: fluxo TikTok real, Telegram real, modelos pagos, carga na VPS.
