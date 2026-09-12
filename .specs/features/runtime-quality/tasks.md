# Runtime Quality Tasks

## Execution Protocol

Usar `tlc-spec-driven` e seu ciclo Execute. Um resultado verificável por tarefa, teste junto da implementação, gate antes de completar, commit atômico incluindo status/traceabilidade. Verificador independente automático depois da última tarefa. Não publicar nem alterar banco de produção.

Design: `.specs/features/runtime-quality/design.md`.
Status: Implementação integrada e gates aprovados; sensor e Verifier independentes pendentes.

## Test Coverage Matrix

Gerada a partir de package.json, scripts/test-ci.ts, regras de projeto já fornecidas e amostras agent-cli/tests/cli.test.ts, server/tests/agent-providers.test.ts, agent-observation.test.ts, agent-browser-tools.test.ts e agent-runtime-loop.integration.test.ts. Regras: cobertura de todas as ACs, casos de erro e limites; código novo com meta mínima de 80% conforme convenção, sem testes triviais de implementação.

| Code Layer | Required Test Type | Coverage Expectation | Location Pattern | Run Command |
|---|---|---|---|---|
| CLI e prompts | unit | ACs de contexto, limites, cancelamento e isolamento | agent-cli/tests/*.test.ts; server/tests/agent-providers.test.ts | bun test nos arquivos nomeados pela tarefa |
| Runtime e dados | integration | Estados persistidos, leases, cancelamento e valores reais de uso | server/tests/agent-runtime-loop.integration.test.ts; server/tests/agent-runs.integration.test.ts | bun test nos arquivos nomeados, com DATABASE_URL de teste explícita |
| Ferramentas e observação | unit + smoke browser | Resultados, ref stale, recusa, segredo, parcial e fallback | server/tests/agent-browser-tools.test.ts; server/tests/agent-observation.test.ts | bun test nos arquivos nomeados; cenário local em Chromium |
| Configuração e seleção | unit + integration | Config inválida, defaults, candidatos e execução de tarefa | server/tests/agent-model-catalog.test.ts; server/tests/agent-runs.integration.test.ts | bun test nos arquivos nomeados |
| Documentação/operação | smoke | Instruções compatíveis com comportamento efetivo | docs/agentic | comandos reais de saúde e smoke local sem publicação |

## Gate Check Commands

| Gate Level | When to Use | Command |
|---|---|---|
| Quick | Unitário | bun test seguido dos arquivos de teste indicados em Tests da tarefa |
| Full | Integração | Gate unitário da tarefa e bun test dos arquivos de integração indicados, com banco dedicado explicitamente configurado |
| Build | Última tarefa da fase | bun run typecheck && bun run build && bun run lint && bun run test:ci, com banco de teste isolado |

Comandos são os scripts existentes do projeto. Nenhum gate pode usar implicitamente banco operacional. Configuração de banco, falhas preexistentes e quantidade de testes devem ser registradas antes de executar o primeiro gate. Não reduzir gate silenciosamente. Falha com causa ambiental deve ser resolvida ou registrada como bloqueio real.

## Execution Plan

Quatro fases temáticas, três tarefas cada. Usuário autorizou paralelismo independente: raízes T1, T4 e T8 podem avançar sem sobrepor arquivos; Main serializa integração dos módulos compartilhados. As demais dependências abaixo continuam obrigatórias.

```
T1 -> T2 -> T3
T4 -> T5 -> T6 -> T7
T8 -> T9 -> T10 -> T11 -> T12
```

## Task Breakdown

### Phase 1: Contexto

### T1: Preservar histórico no envelope CLI

**What**: Substituir seleção da última mensagem por contexto limitado com papéis e truncamento explícito.
**Where**: `agent-cli/src/index.ts`
**Depends on**: None
**Reuses**: perguntaDoTurno e mensagens AG-UI existentes.
**Requirement**: RQ-01
**Done when**:
- [x] Endereço de mensagem anterior chega ao próximo turno da mesma entrada.
- [x] Outra thread não herda conteúdo; mensagem atual não é cortada.
- [x] Excesso antigo é sinalizado; excesso da mensagem atual falha antes do spawn.
**Tests**: unit — agent-cli/tests/cli.test.ts; probe executando montagem real de contexto.
**Gate**: quick
**Commit**: fix(cli): preserve bounded conversation context

Gate T1: `bun test agent-cli/tests/cli.test.ts` — 20 pass, 0 fail. Primeira execução encontrou omissão indevida; corrigida sem alterar assertions.
Cobertura bidirecional RQ-01: AC1 ↔ `agent-cli/tests/cli.test.ts:247` (`expect(pergunta).toContain("Rua das Flores, 123")`); AC2 ↔ linha 262 (`expect(segunda).not.toContain("Rua das Flores")`); AC3 ↔ linhas 278–281 (atual preservada, limite e omissão); AC4 ↔ linha 288 (`expect(() => perguntaDoTurno(entrada)).toThrow(/limite/)`). Testes de modalidade/contrato cobrem validação da mesma entrada. Adequação: resultados observáveis, sem memória global, nenhuma AC sem cobertura.

### T2: Serializar uso do workspace CLI

**What**: Admitir um turno por vez em fila FIFO abortável que cobre preparação e subprocesso.
**Where**: `agent-cli/src/index.ts`
**Depends on**: T1
**Reuses**: runAgent, prepararTurno e AbortSignal existentes.
**Requirement**: RQ-02
**Done when**:
- [x] Dois turnos distintos nunca sobrepõem configuração ou skills.
- [x] Cancelamento em fila não modifica workspace nem encerra turno ativo.
- [x] Erro no processo libera fila, sem starvation dos próximos turnos.
**Tests**: unit — teste concorrente com executável local controlado, em agent-cli/tests; verificar resultado visível por turno e não apenas número de chamadas.
**Gate**: quick
**Commit**: fix(cli): serialize shared workspace execution

Gate T2: `bun test agent-cli/tests/workspace.test.ts agent-cli/tests/cli.test.ts` — 21 pass, 0 fail. Executável local controlado lê config e skill reais em workspace temporário; cancelamento do segundo turno preserva primeiro, terceiro falha e quarto progride. Nenhuma chamada de fornecedor.
Cobertura RQ-02 AC1–AC3 ↔ `agent-cli/tests/workspace.test.ts`, teste `queued cancellation preserves active files; failure releases the next isolated turn`: assertions `beforeRelease === "first"`, `cancelledStarted === false`, `unchanged === true`, skill e assertion próprios do primeiro/último, `RUN_ERROR` do terceiro. Adequação: observa isolamento e progresso, não contagem de mocks.

### T3: Preservar contexto útil sem duplicar regras

**What**: Montar contexto do runtime com restrições humanas e resultados úteis limitados, sem duplicação de system prompt.
**Where**: `server/src/agent-runtime/prompt.ts`
**Depends on**: T2
**Reuses**: historyOf, messagesBlock e adaptadores existentes.
**Integration scope**: Atualizar projeção no loop e todos os adaptadores que consomem userPrompt no mesmo contrato; nenhum adaptador deixado no formato anterior.
**Requirement**: RQ-06
**Done when**:
- [x] Cada envelope tem uma cópia de instrução de sistema no papel apropriado.
- [x] Próximo passo recebe assignments/resultados necessários e restrições humanas anteriores.
- [x] Projeção é limitada e mantém dados não confiáveis separados de instruções.
**Tests**: unit + integration — server/tests/agent-providers.test.ts e agent-run-messages.integration.test.ts; acrescentar regressão observável no loop.
**Gate**: build
**Commit**: fix(runtime): preserve useful decision context

### Phase 2: Confiabilidade

### T4: Corrigir tempo ativo e deadline

**What**: Calcular tempo monotônico sem dupla contagem e abortar operação no limite ativo.
**Where**: `server/src/agent-runtime/loop.ts`
**Depends on**: None
**Reuses**: now injetável, usage, settle e sinal de execução.
**Requirement**: RQ-05
**Done when**:
- [ ] Reprodução anterior da contagem falha antes e passa após correção.
- [x] Três intervalos de 1 segundo resultam em 3 segundos; espera humana excluída.
- [x] Deadline aborta modelo; pausa e cancelamento não são sobrescritos.
**Tests**: integration — server/tests/agent-runtime-loop.integration.test.ts, relógio e provedor controlados, estado real persistido.
**Gate**: full
**Commit**: fix(runtime): account active time monotonically

### T5: Persistir consumo por tentativa

**What**: Expor consumo conhecido e desconhecido de cada tentativa de modelo no runtime.
**Where**: `server/src/agent-runtime/contracts.ts`
**Depends on**: T4
**Integration scope**: Tipos de uso, adaptadores, loop e serialização de run; manter consumo nos JSON existentes quando suficiente.
**Reuses**: RunUsage, eventos do run, respostas e eventos dos provedores.
**Requirement**: RQ-04
**Done when**:
- [x] Duas falhas e sucesso contam três chamadas.
- [x] Tokens e modelo efetivo reportados pelo provedor chegam ao estado retornado/persistido.
- [x] Usage/custo ausente permanece desconhecido e não cria zero fictício.
- [x] Nenhum prompt ou segredo entra na telemetria.
**Tests**: unit + integration — server/tests/agent-providers.test.ts e agent-runtime-loop.integration.test.ts; casos conhecidos, ausentes e retries.
**Gate**: full
**Commit**: feat(runtime): record per-attempt model usage

### T6: Verificar condição de conclusão

**What**: Fechar tarefa por pós-condição host-side em vez de declaração textual de efeito externo.
**Where**: `server/src/agent-runtime/loop.ts`
**Depends on**: T5
**Integration scope**: Contrato/validação de criação, persistência em JSON quando possível, step e delegated, resultado exposto nas superfícies existentes.
**Reuses**: Observação, artefatos, necessidades de reconciliação e máquina de estados.
**Requirement**: RQ-03
**Done when**:
- [x] Pós-condição explícita é validada contra fonte do host.
- [x] Sucesso alegado sem prova externa não produz succeeded.
- [x] Efeito incerto para em needs_reconciliation sem repetição.
- [x] Conversa textual ainda conclui sem imagem artificial.
**Tests**: integration — agent-runtime-loop.integration.test.ts e agent-run-routes.test.ts; critérios inválidos, confirmação verdadeira, prosa falsa e artefato de outro run.
**Gate**: build
**Commit**: feat(runtime): verify task completion conditions

### Phase 3: Eficiência

### T7: Observar sob demanda com coerência

**What**: Consumir screenshot uma vez e reduzir observações redundantes sem misturar gerações.
**Where**: `server/src/agent-runtime/observation.ts`
**Depends on**: T6
**Integration scope**: Loop, gateway/client e endpoint de observação do computador apenas onde necessários ao contrato de coleta coerente.
**Reuses**: Snapshot generation, redaction, captura classificada e controle humano.
**Requirement**: RQ-07
**Done when**:
- [x] Screenshot chega só ao passo seguinte ao pedido.
- [x] Segredo e modelo sem visão não recebem imagem.
- [x] Reaproveitamento não atravessa geração e navegação não mistura texto com refs.
**Tests**: unit + integration — agent-observation.test.ts e agent-runtime-loop.integration.test.ts; smoke Chromium em página local com navegação/re-render.
**Gate**: full
**Commit**: perf(runtime): scope observations to current need

### T8: Preencher formulário em operação governada

**What**: Executar plano de preenchimento com resultado parcial e sem envio final.
**Where**: `server/src/agent-runtime/browser-tools.ts`
**Depends on**: None
**Reuses**: extractForm, planFill, gateway.type/select, classificação de sensibilidade.
**Integration scope**: Catálogo, prompt e MCP compartilhado devem oferecer comportamento equivalente onde a ferramenta for publicada.
**Requirement**: RQ-08
**Done when**:
- [x] Vários campos estáveis são preenchidos sem nova chamada de modelo por campo.
- [x] Estrutura alterada ou erro interrompe demais campos com resultado parcial exato.
- [x] Não executa submit; política e controle humano valem para cada campo.
**Tests**: unit — agent-browser-tools.test.ts; smoke browser de formulário local com sucesso, falha parcial e takeover.
**Gate**: quick
**Commit**: feat(browser): fill forms through governed actions

### T9: Oferecer leitura pública governada

**What**: Expor fetch Lightpanda no catálogo step com fallback técnico explícito.
**Where**: `server/src/agent-runtime/browser-tools.ts`
**Depends on**: T8
**Reuses**: computer_fetch, guardas de destino e transporte Lightpanda existentes.
**Requirement**: RQ-09
**Done when**:
- [x] Leitura pública pode usar fetch sem abrir sessão do Bot.
- [x] Recusa não aciona fallback; indisponibilidade técnica informa alternativa Chromium.
- [x] Tarefa com sessão ou pixels continua no Chromium.
**Tests**: unit — agent-browser-tools.test.ts; smoke de página pública de teste sem credenciais e sem efeito externo.
**Gate**: build
**Commit**: feat(browser): expose governed public page reads

### Phase 4: Operação

### T10: Aplicar política opt-in de modelos

**What**: Selecionar candidatos registrados por política explícita com uma escalada máxima.
**Where**: `server/src/agent-runtime/model-configurations.ts`
**Depends on**: T9
**Integration scope**: Configuração e criação/execução real de tarefas, catálogo e telemetria; sem ativar política na configuração local da pessoa.
**Reuses**: Catálogo, provider registry, precedência tarefa/Bot/deployment.
**Requirement**: RQ-10
**Done when**:
- [x] Sem opt-in, escolha fixa é preservada.
- [x] Política usa só candidatos autorizados e compatíveis.
- [x] Uma escalada máxima é registrada; esgotamento não troca silenciosamente.
**Tests**: unit + integration — agent-model-catalog.test.ts, agent-runs.integration.test.ts e loop; exercitar seleção consumida por um run.
**Gate**: full
**Commit**: feat(runtime): add explicit model routing policy

### T11: Limitar concorrência entre perfis

**What**: Configurar de 1 a 4 runs ativos mantendo exclusão por perfil.
**Where**: `server/src/agent-runs/worker.ts`
**Depends on**: T10
**Integration scope**: Configuração validada e montagem em server/src/index.ts; default 1 preservado.
**Reuses**: Worker existente, claims, leases e fila serializada do CLI.
**Requirement**: RQ-11
**Done when**:
- [x] Default 1 e limite configurado são respeitados.
- [x] Mesmo perfil nunca age em paralelo; perfis diferentes progridem.
- [x] Configuração fora do intervalo falha no boot.
**Tests**: integration — testes existentes de worker/agent-runs localizados antes de editar; caso de saturação e de mesmo perfil.
**Gate**: full
**Commit**: feat(runtime): bound concurrent profile execution

### T12: Alinhar documentação operacional

**What**: Documentar contratos implementados, isolamento real e limites medidos.
**Where**: `docs/agentic/architecture.md`
**Depends on**: T11
**Integration scope**: Documentação de configuração/provedores/segurança e descrição incorreta do provider shared, somente pontos alterados pela feature.
**Reuses**: Relatório atual, comandos existentes e evidência dos gates.
**Requirement**: RQ-12
**Done when**:
- [x] Descrição diferencia perfil de processo/container.
- [x] Defaults e comandos correspondem ao comportamento verificado.
- [x] Relatório distingue evidência local, histórica e homologação externa não feita.
**Tests**: smoke — executar saúde e cenário local; conferir configuração efetiva sem expor segredos.
**Gate**: build
**Commit**: docs(runtime): document quality and execution contracts

## Diagram-Definition Cross-Check

| Task | Depends On | Diagram Shows | Status |
|---|---|---|---|
| T1 | None | Entrada | Match |
| T2 | T1 | T1 para T2 | Match |
| T3 | T2 | T2 para T3 | Match |
| T4 | None | Entrada independente | Match |
| T5 | T4 | T4 para T5 | Match |
| T6 | T5 | T5 para T6 | Match |
| T7 | T6 | T6 para T7 | Match |
| T8 | None | Entrada independente | Match |
| T9 | T8 | T8 para T9 | Match |
| T10 | T9 | T9 para T10 | Match |
| T11 | T10 | T10 para T11 | Match |
| T12 | T11 | T11 para T12 | Match |

## Test Co-location Validation

| Tasks | Layer | Required | Tests | Status |
|---|---|---|---|---|
| T1, T2 | CLI | unit | unit | Match |
| T3 | Contexto/runtime | unit + integration | unit + integration | Match |
| T4, T6 | Estados | integration | integration | Match |
| T5 | Uso e adaptadores | unit + integration | unit + integration | Match |
| T7 | Observação | unit + integration + smoke | unit + integration + smoke | Match |
| T8, T9 | Ferramentas | unit + smoke | unit + smoke | Match |
| T10 | Configuração e seleção | unit + integration | unit + integration | Match |
| T11 | Worker | integration | integration | Match |
| T12 | Operação | smoke | smoke | Match |

## Task Granularity Check

Cada tarefa entrega um componente/contrato observável. Where aponta o proprietário principal, não oculta integrações: Integration scope explicita consumidores que precisam migrar no mesmo commit para não entregar scaffold. T3, T5, T6 e T7 têm integração multifile inseparável do contrato; não dividir tipos, implementação e consumo em tarefas que não possam ser validadas isoladamente.

## Tools

Ferramentas nativas de leitura/edição, LSP quando disponível, Bun e Chromium local. Context7 para contrato de biblioteca incerto. Skills de implementação/segurança pertinentes carregadas antes da alteração. Não instalar ferramentas nem iniciar agente remoto.

## Completion

Após T12: Verifier independente com spec, diff e testes; sensor de pelo menos cinco mutações em cópia isolada por haver caminhos P0. Relatório validation.md PASS obrigatório, seguido de validate_state.py. Não declarar conclusão com etapas abertas.

## Evidência da integração

Gates executados em 2026-09-12, com `DATABASE_URL` explícita do banco descartável `runtime_quality_test`, porta 55439:

- `bun run typecheck`: exit 0.
- `bun run build`: exit 0; aviso de chunk frontend maior que 500 kB.
- `bun run lint`: exit 0; 24 warnings e 1 informação de versão do schema Biome. Nenhuma supressão acrescentada.
- `bun run test:ci`: 1.283 pass, 5 skip, 0 fail.
- Chromium real por gateway: dois campos, duas ações auditadas, zero submit; mudança estrutural e takeover param antes do campo seguinte.
- Lightpanda real por gateway: página de teste local devolveu título/texto, sem sessão do Bot.

T4 mantém aberta somente a prova de discriminação antes/depois, a ser produzida em cópia isolada. Cobertura percentual de linhas novas não foi medida; contagens acima não equivalem a esse percentual. Relatório final deve citar testes por nome e linhas atuais: referências de T1 anteriores à formatação são históricas.

Integração dos módulos compartilhados T3–T12 foi validada conjuntamente após as slices paralelas, em vez de gates intermediários durante edições concorrentes. A revisão independente ainda decide aceitação final.
