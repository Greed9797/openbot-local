# Arquitetura — OpenBot agêntico

Como as peças do agente de browser se encaixam e por onde passa um passo de tarefa.
Implementado sem homologação em ambiente real (sem fluxo TikTok real, Telegram real,
modelos pagos ou VPS).

## Componentes

| Camada | Arquivo | Papel |
|---|---|---|
| Entrada web | `server/src/agent-runs/routes.ts` (`createAgentRunRoutes`, montada em `/api/agent-runs` por `server/src/app.ts`) | CRUD de tarefas, mensagens, aprovações, captura sob demanda, SSE de eventos |
| Entrada Telegram | `server/src/telegram/{poller,handler,sender,notifier,store,routes}.ts` | Long polling, conversa, outbox, pareamento; nunca fala com o computador direto |
| Núcleo | `server/src/agent-runs/{service,repository}.ts` | Máquina de estados (`createAgentRunService`) e persistência (`createAgentRunRepository`) |
| Fila | `server/src/agent-runs/worker.ts` (`createAgentRunWorker`) | `claim`, heartbeat, `recoverExpired`, concorrência 1 |
| Executor | `server/src/agent-runtime/loop.ts` (`createAgentRunExecutor`) | Loop observar→decidir→agir; montado em `server/src/index.ts` |
| Observação | `server/src/agent-runtime/observation.ts` (`createGatewayObservationSource`) | Snapshot + texto + captura classificada |
| Catálogo | `server/src/agent-runtime/browser-tools.ts` (`createBrowserTools`) | 13 ferramentas (`navigate`, `read_page`, `snapshot_page`, `click`, `type_text`, `press_key`, `scroll`, `select_option`, `screenshot`, `wait_for`, `request_help`, `read_form`, `plan_form`); só ele executa |
| Provedores | `server/src/agent-runtime/providers/*`, `registry.ts` | OpenAI Responses, Anthropic Messages, Gemini (API nativa), `/v1/chat/completions` local e o transporte `delegated` — Codex e os CLIs de agente |
| Catálogo de modelos | `server/src/agent-runtime/model-catalog.ts`, `GET /api/models` e `POST /api/models/refresh` em `app.ts` | O que este deployment alcança: id, modelo, transporte, `capabilities` e o padrão — inclusive os modelos que cada serviço delegado diz ter (`GET /models`), recoletados sem deploy pelo refresh |
| Escolha de modelo | `agents.configuration` (`provider`/`model`) + `agent-runs/service.ts` | Tarefa → Bot → deployment, resolvido na criação; provedor ou modelo fora do catálogo é 400 na porta, e um provedor que sumiu do deployment fecha a tarefa com `PROVIDER_UNAVAILABLE` |
| Portão de aprovação | `server/src/agent-runs/approvals.ts` (`createApprovalGate`) + `server/src/agent-runtime/sensitive-actions.ts` (`classifyAction`) | Sensível exige pessoa antes do navegador |
| Gateway | `server/src/computer/gateway.ts` (`govern`, `resolve`) | Política CEL, auditoria antes da ação, resolução de ref contra geração do snapshot |
| Navegador | `agent-computer/src/index.ts` | Chromium/Playwright por Bot, máscaras de screenshot, segredos, controle humano |
| Leitura barata | `computer_fetch` via gateway → `agent-computer/src/lightpanda.ts` | Texto sem pixels, sem sessão |
| Codex delegado | `agent-codex/src/index.ts` + `shared/mcp-computer.ts` (`abrir_pagina`, `ler_url_rapido`, `ler_pagina`, `mapear_pagina`, `clicar`, `digitar`, `tecla`, `rolar`, `ver_a_tela`, `pedir_ajuda`, `escolher_opcao`) | O CLI conduz o próprio ciclo; o servidor MCP stdio é o mesmo que os CLIs de agente usam, e as ferramentas de navegador passam pelo gateway |
| CLI de agente | `agent-cli/src/{index,cli}.ts` | Um serviço por CLI (OpenCode, MiMo Code); entrega a tarefa inteira ao binário e o navegador chega pelo mesmo `shared/mcp-computer.ts` |
| Imagens | `server/src/agent-runtime/{artifact-store,image-input}.ts`, `server/src/agent-runs/capture.ts` (`captureRunScreen`) | Arquivo no disco + linha em `run_artifacts` com classificação e destinos |

## O caminho de um passo

```
web (POST /api/agent-runs) ou Telegram ("faz X")
  → AgentRunService.createRun → linha em agent_runs, status queued
  → createAgentRunWorker.tick: recoverExpired, repository.claim (leaseOwner/leaseGeneration/leaseExpiresAt)
  → createAgentRunExecutor.execute:
      repository.acquireProfileLease (browser_profile_leases, uma posse por perfil)
      observations.observe: gateway.control + gateway.snapshot (texto e refs do mesmo documento)
        (+ gateway.read apenas se o snapshot não contiver texto; screenshot apenas sob pedido)
      provider.run(input com observation, history, messages, tools, budget, usage)
      approvals.review(call, observation) → run | approved | requested | denied
      tools.execute(call, {runId, botId, stepSeq, actor, signal})
        → gateway.govern → política → auditoria → agent-computer → Chromium
      grava agent_run_steps + agent_run_events, atualiza usage e checkpoint
      RunNotifier.statusChanged → notification_outbox (Telegram avisa depois)
```

O executor só anda com `status === "running"` e só escreve enquanto detém o lease
(`updateOwned` com owner+generation; escrita recusada significa que o lease mudou de dono).
Pausa/cancelamento no meio de uma chamada de modelo não é desfeito: `advance()` só muda
estado partindo de `running`/`waiting_model`, e o heartbeat (1–2 s) aborta o passo via
`AbortSignal` quando o estado sai de `ACTIVE` (`running`, `waiting_model`, `executing`).

## Lightpanda × Chromium

| | Lightpanda (`computer_fetch`, `fetch_page`, `ler_url_rapido`) | Chromium (todo o resto) |
|---|---|---|
| O que é | Motor sem pixels (`agent-computer/src/lightpanda.ts`) | Navegador persistente por Bot com sessão e perfil |
| Devolve | `FetchResult`: texto + links, sem abrir nada no computador do Bot | Snapshot ARIA com refs, texto da página aberta, screenshot |
| Quando usar | "Leia esta página e me diga o conteúdo" | Login, formulário, canvas, qualquer coisa visual ou com estado |
| No runtime | `fetch_page` no catálogo step; recusa é terminal, falha técnica oferece alternativa explícita `navigate` + `read_page`, ainda governada | Observação e interação com sessão permanecem Chromium (`textOnly: false`) |

## Diagrama

```
                +-----------------+      +------------------+
                | painel web      |      | Telegram         |
                | /api/agent-runs |      | poller→handler   |
                +--------+--------+      +--------+---------+
                         |                        |
                         v                        v
                  +--------------------------------------+
                  | AgentRunService (estados)            |
                  | agent_runs / steps / events /        |
                  | messages / approvals / artifacts    |
                  +--------------------------------------+
                         |  claim/lease (worker, conc. 1)
                         v
                  +--------------------------------------+
                  | createAgentRunExecutor (loop)        |
                  |  observe → provider → approval gate  |
                  |  → ToolCatalog.execute               |
                  +--------------------------------------+
                    |                |              |
              providers/     approvals.ts     browser-tools.ts
       (5 transportes)  (run_approvals)         |
                                                    v
                                    +------------------------------+
                                    | ComputerGateway.govern       |
                                    | política + auditoria antes   |
                                    +---------------+--------------+
                                                    |
                                    +---------------v--------------+
                                    | agent-computer (Chromium)    |
                                    | Lightpanda só p/ fetch       |
                                    +------------------------------+
```

## Limites e não-objetivos

- Worker começa com `AGENT_CONCURRENCY=1`; aceita valores inteiros de 1 a 4. Leases por perfil continuam exclusivos: outra tarefa do mesmo perfil aguarda em `queued` com `run.queued_for_profile`.
- Sem abas, upload, download ou `hover` no catálogo do runtime: só entram quando um caso
  P0 exigir (decisão D-07 do plano). `select_option`, `read_form`, `plan_form` e `fill_form` cobrem formulários sem submit implícito.
- Sem shell governado no modo `step`: o modelo só alcança o que o catálogo expõe; shell
  existe apenas no caminho Codex, fora desta garantia (ver `security.md`).
- Sem truncamento silencioso: `FetchResult`/leitura carregam `truncated`, e a observação
  carrega `redactions` (contagem do `redactSecrets`).
- Sem provedor padrão silencioso diferente do configurado: `createProviderRegistry.default()`
  é `providers[0]`, e `AGENT_DEFAULT_PROVIDER` explícito e ausente recusa o boot.

## Contratos de qualidade do runtime

### Memória e isolamento

- CLI recebe histórico do pedido AG-UI com papéis, limitado a 48.000 caracteres. Mensagens antigas saem inteiras, com aviso; mensagem atual nunca é cortada. Excedente irredutível recusa antes de preparar arquivos ou iniciar CLI.
- Uma fila FIFO por processo protege preparação, configuração, skills e subprocesso. Cancelar um turno aguardando não altera arquivos nem encerra o ativo. Não é sandbox entre processos.
- Runtime conserva resultados úteis de ferramentas (até 2.000 caracteres por passo, últimos 20 passos), com proveniência não confiável. Instruções de sistema aparecem uma vez; objetivo e mensagens ficam no envelope variável.
- Mensagens humanas já entregues permanecem inteiras; as mais recentes vêm por último. Acima de 48.000 caracteres de instruções humanas, a tarefa para explicitamente por limite de contexto, sem esquecer uma restrição silenciosamente.
- Serviço de computador compartilhado mantém perfis/contextos de navegador separados por Bot, mas compartilha processo e `/workspace`. Supervisor/container por Bot é outra camada de isolamento.

### Conclusão observada pelo host

`POST /api/agent-runs` aceita `completion`:

```json
{"kind":"page_text","text":"Pedido confirmado"}
```

Também aceita `{"kind":"page_url","url":"https://loja.example/confirmacao"}` ou `{"kind":"artifact"}`. A condição de artefato pode restringir `artifactId`; sem id, exige ao menos um artefato retido, pertencente ao run, com bytes existentes em disco. Metadata arbitrário não pode forjar condição ou resultado verificado.

Na decisão final, o host faz observação fresca para condições de página. Prosa do modelo não confirma efeito externo: resultado incerto ou condição não satisfeita leva a `needs_reconciliation`, sem repetir ação. Tarefa textual sem efeitos dispensa screenshot. No modo delegado, ferramentas usadas sem prova de conclusão são tratadas conservadoramente.

### Consumo e tempo

`usage.modelCalls` conta cada tentativa, inclusive falhas. `usage.attempts` expõe provedor/modelo efetivos e tokens de entrada, saída e cache quando reportados; ausência é `null`. Custo monetário continua desconhecido sem tarifa reportada; não há estimativa inventada nem prompts/credenciais nessa telemetria.

Tempo ativo usa base persistida da retomada mais delta monotônico da execução atual. Espera por pessoa fica fora. Deadline aborta chamada em andamento; pausa/cancelamento prevalecem.

### Observação e formulário composto

Snapshot nativo agrega texto e refs após conferir documento/URL antes e depois da coleta. Não existe cache entre gerações. Leituras incompatíveis são descartadas; screenshot solicitada vale somente para observação seguinte. Controle humano, entrada de segredo e classificação de captura continuam bloqueando envio.

`fill_form` / MCP `preencher_formulario` recebem `values: [{label,value}]`. Cada campo passa por política, auditoria e ação do gateway. Não há Enter ou submit. Rótulos ambíguos não são adivinhados; mudança de URL/estrutura, falha ou takeover interrompe com concluídos/pendentes, sem valores no resultado. A auditoria recebe run da declaração assinada; chamada humana não inventa run.

### Roteamento explícito

Sem `AGENT_ROUTING_POLICY`, seleção fixa permanece igual. Exemplo opt-in:

```sh
AGENT_ROUTING_POLICY='{"primary":"openai","fallback":"anthropic"}'
```

Ids devem estar configurados. Política registra provedor sintético `routed`, sem substituir padrão ou Bot existente. Para autorizar seleção automática, a tarefa escolhe `provider: "routed"` sem fixar modelo; modelo explícito fica preso ao candidato correspondente e não autoriza trocar por outro modelo.

Seleção considera capacidades. Falha retentável permite uma escalada para fallback autorizado; tentativas persistidas mantêm escolha nos próximos passos/retomadas. Recusa e cancelamento não escalam. O laço não acrescenta retries ao roteador.

### Evidência local

Validação desta feature usa banco descartável separado do operacional. Foram exercitados CLI local controlado, Chromium em container descartável, preenchimento por gateway com auditoria, mudança estrutural, takeover e leitura Lightpanda de página local sem sessão. Relatório definitivo de gates e revisão independente: `.specs/features/runtime-quality/validation.md`. Resultados históricos de outras baterias não contam como evidência desta mudança.
