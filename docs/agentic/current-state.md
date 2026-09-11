# Estado atual — OpenBot local

**Fase 0 do plano agêntico.** Nenhuma mudança de comportamento foi feita para produzir este
documento: ele inventaria o que existe no código, confere os achados da auditoria de 11/09/2026
contra os arquivos reais e registra o resultado da suíte. As decisões e o desenho da evolução estão
em `implementation-plan.md`.

## 1. Identidade e ambiente de verificação

| Item | Valor |
|---|---|
| Repositório | `Greed9797/openbot-local` (fork do OpenBot/CopilotKit) |
| Branch | `local-fork` |
| Commit | `0e623a182358a9425f5af574a1e24ca5279fadc8` (24/08/2026) — o mesmo commit auditado |
| Ambiente | macOS 25.3.0 (arm64), Bun 1.3.12, Docker 29.5.2 |
| Banco de teste | Postgres `pgvector/pgvector:pg17` do compose, publicado em `127.0.0.1:5433` neste clone (default do compose é `${POSTGRES_PORT:-5432}` em todas as interfaces — ver A08) |
| `.env` | Criado localmente a partir de `.env.example`, com tokens aleatórios e `RUNTIME_MODE=local`. Não rastreado. |

### Suíte, executada nesta máquina

```bash
bun install                                  # raiz
bun run generate:app-config                  # gera app/src/lib/generated/application-config
(cd agent-codex && bun install)              # subpacotes fora dos workspaces da raiz
(cd agent-computer && bun install)
(cd supervisor && bun install)
(cd server && bun run db:migrate)            # aplica server/drizzle/* no banco acima
MANAGED_AGENT_TOKEN=teste bun test
```

Resultado real: **998 testes, 993 pass, 5 skip, 0 fail** (98 arquivos, 7,2 s).

Diferenças em relação ao `HANDOFF.md` (que registra 984 testes sem falha):

1. Os pacotes `agent-codex`, `agent-computer` e `supervisor` não estão nos `workspaces` da raiz;
   sem `bun install` próprio, seus testes não importam (`Cannot find module '@ag-ui/encoder'`).
2. O teste `app/tests/router.test.ts` exige `bun run generate:app-config` antes.
3. `server/tests/tenant-package.test.ts:240` usava `new URL(...).pathname`, que percent-encoda
   espaços no caminho (`Open%20botw3`) e quebrava em qualquer diretório com espaço. Corrigido para
   `fileURLToPath` — é a única mudança feita até aqui, fora de código de produto.
4. 5 testes são pulados por padrão (`skip`), como no repositório.

## 2. Inventário dos serviços

| Serviço | Papel | Entrada |
|---|---|---|
| `server` | API Hono, CopilotKit SSE local, gateway de computador, política CEL, auditoria, agentes, canais, credenciais, conectores | `server/src/index.ts`, `server/src/app.ts:42` |
| `agent-computer` | Navegador Chromium/Playwright persistente por Bot, snapshot ARIA com refs, screenshot, controle humano, segredos, shell, workspace, fetch Lightpanda, screencast | `agent-computer/src/index.ts` |
| `agent-codex` | Executor `codex exec` com servidor MCP stdio próprio para as ferramentas de navegador | `agent-codex/src/index.ts`, `agent-codex/src/mcp-computer.ts` |
| `supervisor` | Ciclo de vida de containers Docker por Bot (ensure/stop/reset/list) | `supervisor/src/index.ts` |
| `worker` | Praticamente vazio: imprime `idle` e reexporta um runner de conectores | `worker/src/index.ts`, `worker/src/status.ts` |
| `app` | Interface React; fala CopilotKit e as rotas `/api/computers/:botId/*` via ferramentas de frontend | `app/src/lib/copilot/computer-tools.tsx` |

### Fluxo de uma ação de navegador (o que já é bom e não pode ser contornado)

1. Origem: `POST /api/computers/:botId/<ação>` (`server/src/computer/routes.ts:310` etc.). Um Bot se
   autentica com `x-openbot-agent-token` + `x-openbot-run` (`routes.ts:73-124`); um humano usa a
   sessão e `canUseBot` (`routes.ts:189-201`).
2. `gateway.govern` (`server/src/computer/gateway.ts:363`): resolve o ref contra o snapshot
   persistido (`snapshot-store.ts`, geração exata), monta o contexto CEL, avalia a política
   (`policy.ts:226`), **grava a auditoria antes de executar** e só então chama o computador. Recusa
   vira `ActionRefusedError`; falha depois do "allowed" ganha linha própria.
3. Transporte autenticado para o processo do computador (`computer/client.ts:96`).
4. `agent-computer` executa com Playwright, checando de novo a geração do snapshot
   (`refs.ts:51-93`).

Eventos de auditoria já existentes para isso: `computer.action_allowed`, `computer.action_refused`,
`computer.action_failed`, `computer.help_requested`, `computer.control_taken`,
`computer.control_released`, `computer.secret_requested`, `computer.secret_supplied`,
`computer.stopped`, `computer.reset` (`server/src/audit.ts:54-90`).

### Ferramentas de computador já modeladas

`COMPUTER_TOOLS` e `COMPUTER_ACTING_TOOLS` (`server/src/computer/schema.ts:19-74`): navigate, fetch,
screenshot, read, snapshot, click, type, key, scroll, read_file, write_file, list_files. Screenshot é
read-only e **não** passa pelo `govern` — nem humano, nem Bot pagam política por tirar uma foto da
própria tela.

### Controle humano e segredos

`agent-computer/src/control.ts:87-207`: `holder: 'bot' | 'human'`, `requestHelp`, `take`, `release`,
`requestSecret`/`supplySecret`. `assertBotMayAct` recusa ação do Bot enquanto o humano dirige. O valor
do segredo nunca é retornado, registrado nem auditado — só `characters`.

### Persistência existente

30 tabelas Drizzle em `server/src/db/schema/` (core, computer, coworker, components, plugins).
Para threads, `local_thread_history` (`core.ts:485-510`) guarda o snapshot de mensagens, com
preload das 500 mais recentes (`server/src/copilot-runner.ts:20-58`) e `onConcurrentRun: "supersede"`.
Há grants por linha (ausência = negação) em `plugin_grants`, `component_functions`, e draft/publish
em componentes. Migrações: `server/drizzle/0000..0007`, geradas e aplicadas com
`bun run db:generate` / `db:migrate` (`server/package.json:9-10`).

## 3. Conferência da auditoria de 11/09/2026

| Achado | Estado no código | Evidência |
|---|---|---|
| A01 — imagens não chegam pela ponte MCP | **Confirmado.** O catálogo MCP não tem screenshot nem pedido de ajuda; todo resultado é `{type:"text", text: JSON.stringify(...)}`. | `agent-codex/src/mcp-computer.ts` (catálogo com 8 ferramentas + conhecimento; `reply` textual) |
| A02 — agente de API de exemplo não é executor | **Confirmado.** Conteúdo convertido com `String(message.content ?? "")`; o ciclo termina nas ferramentas. | `agent-bot/src/index.ts:61,65,73` |
| A03 — histórico durável ≠ tarefa recuperável | **Confirmado.** Snapshot só ao encerrar/falhar; cache de 500 threads; `supersede`; eventos em memória. | `copilot-runner.ts:20-58,75-130` |
| A04 — Telegram não existe | **Confirmado.** `grep -i telegram` sem resultado em todo o repositório. | — |
| A05 — shell do Codex é segunda fronteira | **Confirmado e documentado pelo próprio projeto.** O shell fica sob as flags do sandbox; as ferramentas de navegador passam pelo gateway. `danger-full-access` é recusado. | `docs/vps.md` ("O shell dele não passa"); `agent-codex/src/index.ts` |
| A06 — screenshot sem proteção | **Confirmado.** `/screenshot` devolve `base64`/dimensões/`url`/`capturedAt` sem máscara nem classificação. | `agent-computer/src/index.ts:590-611` (via `server/src/computer/gateway.ts:294`) |
| A07 — Lightpanda `nightly` mutável | **Confirmado.** `ARG LIGHTPANDA_RELEASE=nightly`, download sem checksum. | `lightpanda/Dockerfile:24-35` |
| A08 — defaults de publicação | **Confirmado.** `${POSTGRES_PORT:-5432}` publica em todas as interfaces; supervisor em `0.0.0.0:4500`; restantes em loopback. | `docker-compose.yml:12,159` |
| A09 — README do upstream conflita com o fork | **Confirmado.** README descreve Intelligence/licença; o fork roda `RUNTIME_MODE=local` com Codex. | `README.md`, `docs/vps.md` |
| A10 — Lightpanda sem indicador de truncamento | **Confirmado no contrato.** `FetchResult` não tem `truncated`; texto cortado em 40k e links em 100 sem declarar corte. | `server/src/computer/schema.ts:127-135`, `agent-computer/src/lightpanda.ts` |
| A11 — perfil não é isolamento completo | **Confirmado.** `--password-store=basic` sempre; sandbox Chromium só com `COMPUTER_SANDBOX=on`. | `agent-computer/src/profiles.ts:88,94-97` |

Nenhum dos achados foi refutado. A hipótese do PRD de que a separação Lightpanda/Chromium precisa ser
construída também está incorreta: ela já existe (`fetch` sem pixels vs. Chromium com sessão).

## 4. O que ainda não existe (base do plano)

- Núcleo de tarefas duráveis: nenhuma tabela, nenhum estado, nenhum worker que consuma fila. O
  `worker/` é um stub.
- Abstração de provedor de modelo: o único executor é o Codex, dentro do `agent-codex`; não há
  contrato `AgentModelProvider` nem adaptadores de API.
- Loop agêntico no servidor: o ciclo observar→decidir→agir existe (a) no Codex, que conduz o próprio
  ciclo, e (b) no navegador do usuário, via ferramentas de frontend. Não há executor no servidor que
  sobreviva ao fechamento da aba.
- Visão ponta a ponta: screenshot existe na rota, não como conteúdo de imagem entregue ao modelo.
- Telegram: ausente.
- Aprovações explícitas de ação sensível: ausentes. O que existe é a recusa por política e o
  handover de controle.
- Leases de execução por perfil: existe apenas o lock de *launch* em memória por `botId`
  (`profiles.ts:134,160-184`), que não é lease de execução entre réplicas.
- Idempotência de mensagens/canais, orçamentos, retenção de artefatos e classificação de dados:
  ausentes.

## 5. Limites desta verificação

- Não houve VPS, conta TikTok, conta Telegram, credencial de modelo de API nem Codex CLI autenticado
  nesta máquina. O que depende deles fica **implementado e testado com fixture/mock identificado**,
  nunca "homologado".
- O container `agent-codex` roda `codex exec`; seu comportamento real só se comprova no ambiente
  alvo, como o próprio fork documenta.
- As tabelas novas e migrações são exercitadas contra o Postgres real do compose.

## 6. Invariantes a preservar em todas as fases

1. **O gateway é o único caminho** para qualquer ação de navegador, e a auditoria é gravada antes da
   ação.
2. **Política nega por padrão**; regra quebrada recusa.
3. **Referência só resolve contra a geração do snapshot que a produziu**; página que mudou exige nova
   observação.
4. **Segredo nunca entra em transcript, log ou auditoria**; screenshot durante entrada de segredo não
   é divulgada.
5. **Controle humano vence o Bot**: enquanto o humano dirige, ação do Bot é recusada, não enfileirada.
6. **Nada de `danger-full-access`**; o modo browser do novo runtime não herda shell irrestrito.
7. **Codex continua funcionando** como adaptador; nenhuma rota existente quebra.
