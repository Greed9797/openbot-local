# Runtime Quality — Validation

**Result: PASS**

Escopo: `824893b..d29e339`, RQ-01–RQ-12. Parecer independente de `AcceptanceReview`: revisão inicial de `3a94b94`, dois achados corrigidos e reavaliação de `d29e339`, seguida de adjudicação do sensor. Nenhum achado aberto.

Este documento foi consolidado por Main a partir do parecer PASS completo enviado pelo revisor por mensagem. O revisor executou somente inspeção estática; não executou gates, smokes ou sensor. Resultados dinâmicos abaixo foram executados por Main. Autoria dos operadores de mutação: agente independente `RegressionSensor`.

## Gates finais

Evidência durável: [gates.json](evidence/gates.json), com commit e hashes dos logs observados.

| Comando | Resultado |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run build` | exit 0; aviso de chunk frontend acima de 500 kB |
| `bun run lint` | exit 0; 24 warnings e 1 informação de versão Biome; nenhuma supressão nova |
| `bun run test:ci` | exit 0; **1.286 pass, 5 skip, 0 fail** |

Os cinco skips são ambientais preexistentes: três verificações de deployment e duas de Bot-computer. Nenhum skip nos testes novos de runtime-quality. Banco de validação descartável, separado do operacional.

## Cobertura medida

[coverage.json](evidence/coverage.json): **1.394/1.637 = 85,16%** das linhas executáveis adicionadas e instrumentadas, contra base `824893b`.

Não foram instrumentados `agent-computer/src/index.ts`, `server/src/index.ts`, `server/src/agent-runs/types.ts` e `server/src/computer/schema.ts`. Chromium teve smoke real separado. Não extrapolar esse percentual para todos os arquivos ou para todo o código novo; contagem de testes não substitui cobertura.

## Sensor independente

[sensor.json](evidence/sensor.json): **PASS, 7/7 mutações detectadas**, todos os baselines verdes, nenhuma mutação ignorada, sobrevivente, inconclusiva ou com erro de infraestrutura na execução final. Checkout permaneceu intacto. Operadores exatos, comandos, diagnósticos e proveniência estão no JSON.

| Mutação | Contrato e evidência discriminante |
|---|---|
| M1 — perda de histórico CLI | RQ-01 AC1/AC3; `agent-cli/tests/cli.test.ts:243`, `agent-cli/tests/cli.test.ts:277`; histórico removido quebra continuidade e marcador de omissão |
| M2 — bypass da fila CLI | RQ-02 AC1; `agent-cli/tests/workspace.test.ts:80`; arquivo do turno ativo deveria permanecer `first`, mas vira `last` |
| M3 — tempo contado em dobro | RQ-05 AC1; `server/tests/agent-runtime-loop.integration.test.ts:541`; esperado 3.000 ms, recebido 6.000 ms |
| M4 — tentativas colapsadas | RQ-04 AC1; `server/tests/agent-runtime-loop.integration.test.ts:665`; esperado 3, recebido 1 |
| M5 — prosa aceita como prova | RQ-03 AC4; `server/tests/agent-runtime-loop.integration.test.ts:908`; esperado `needs_reconciliation`, recebido `succeeded` |
| M6 — reutilização do plano obsoleto | RQ-08 AC1; `server/tests/agent-browser-tools.test.ts:515`; formulário estável deveria ser preenchido, mas retorna falha |
| M7 — perda de pin igual ao padrão | RQ-10; `server/tests/agent-runtime-loop.integration.test.ts:1315`; após retomada, deveria falhar no modelo fixado, mas conclui por fallback não autorizado |

Histórico preservado em [sensor-initial.json](evidence/sensor-initial.json): primeira execução completa teve seis mutações detectadas e um sobrevivente honesto. M6 alterava o plano, mas o teste selecionado exercitava remoção de campo, ainda protegida por guarda estrutural independente. O autor independente manteve a mutação e selecionou o teste **já existente** de preenchimento estável. Não foram alteradas assertions nem código de produção para obter aprovação.

Antes dessa execução, o runner falhou por não capturar stdout do subprocesso. Main corrigiu somente captura `PIPE`/`STDOUT`; operadores e assertions permaneceram independentes. Falha instrumental não foi contada como detecção de regressão.

## Matriz de aceitação

A matriz consolida o cotejo independente de todos os critérios numerados na spec. Citações correspondem ao código de `d29e339`; listas de testes cobrem o conjunto de ACs indicado.

| Requisito / ACs | Implementação | Testes e prova |
|---|---|---|
| RQ-01 AC1–AC4 | `agent-cli/src/index.ts:254` | `agent-cli/tests/cli.test.ts:243`, `agent-cli/tests/cli.test.ts:258`, `agent-cli/tests/cli.test.ts:277`, `agent-cli/tests/cli.test.ts:297`; M1 |
| RQ-02 AC1–AC3 | `agent-cli/src/index.ts:597` | `agent-cli/tests/workspace.test.ts:9`; processo real controlado, cancelamento na fila, isolamento de arquivos e progresso após falha; M2 |
| RQ-03 AC1–AC4 | `server/src/agent-runtime/loop.ts:502`, `server/src/agent-runtime/contracts.ts:162`, `server/src/agent-runs/service.ts:352` | `server/tests/agent-runtime-loop.integration.test.ts:899`, `server/tests/agent-runtime-loop.integration.test.ts:917`, `server/tests/agent-runtime-loop.integration.test.ts:937`, `server/tests/agent-runtime-loop.integration.test.ts:960`, `server/tests/agent-runtime-loop.integration.test.ts:981`, `server/tests/agent-runtime-loop.integration.test.ts:1051`, `server/tests/agent-runtime-loop.integration.test.ts:1062`, `server/tests/agent-runtime-loop.integration.test.ts:1088`; M5 |
| RQ-04 AC1–AC4 | `server/src/agent-runtime/loop.ts:484`, `server/src/agent-runtime/contracts.ts:234` | `server/tests/agent-runtime-loop.integration.test.ts:639`, `server/tests/agent-runtime-loop.integration.test.ts:772`, `server/tests/agent-runtime-loop.integration.test.ts:1119`, `server/tests/agent-runtime-loop.integration.test.ts:1193`, `server/tests/agent-providers.test.ts:894`, `server/tests/agent-providers.test.ts:1027`; M4 |
| RQ-05 AC1–AC4 | `server/src/agent-runtime/loop.ts:471`, `server/src/agent-runtime/loop.ts:585` | `server/tests/agent-runtime-loop.integration.test.ts:519`, `server/tests/agent-runtime-loop.integration.test.ts:544`, `server/tests/agent-runtime-loop.integration.test.ts:564`, `server/tests/agent-runtime-loop.integration.test.ts:590`, `server/tests/agent-runtime-loop.integration.test.ts:615`; M3 |
| RQ-06 AC1–AC4 | `server/src/agent-runtime/prompt.ts:48`, `server/src/agent-runtime/prompt.ts:203` | `server/tests/agent-context.test.ts:33`, `server/tests/agent-context.test.ts:41`, `server/tests/agent-context.test.ts:64`, `server/tests/agent-context.test.ts:74`, `server/tests/agent-context.test.ts:89`, `server/tests/agent-context.test.ts:96`, `server/tests/agent-providers.test.ts:1075`, `server/tests/agent-runtime-loop.integration.test.ts:683`, `server/tests/agent-runtime-loop.integration.test.ts:710`, `server/tests/agent-runtime-loop.integration.test.ts:731`, `server/tests/agent-runtime-loop.integration.test.ts:753` |
| RQ-07 AC1–AC5 | `server/src/agent-runtime/observation.ts:47`, `server/src/agent-runtime/observation.ts:105`, `agent-computer/src/index.ts:251` | `server/tests/agent-observation.test.ts:142`, `server/tests/agent-observation.test.ts:215`, `server/tests/agent-observation.test.ts:238`, `server/tests/agent-observation.test.ts:256`, `server/tests/agent-observation.test.ts:278`, `server/tests/agent-observation.test.ts:297`, `server/tests/agent-observation.test.ts:319`, `server/tests/agent-runtime-loop.integration.test.ts:805`; Chromium real |
| RQ-08 AC1–AC4 | `server/src/agent-runtime/browser-tools.ts:568`, `server/src/computer/routes.ts:99`, `server/src/computer/routes.ts:661` | `server/tests/agent-browser-tools.test.ts:453`, `server/tests/agent-browser-tools.test.ts:539`, `server/tests/agent-browser-tools.test.ts:598`, `server/tests/agent-browser-tools.test.ts:671`, `server/tests/agent-browser-tools.test.ts:731`, `server/tests/agent-browser-tools.test.ts:800`, `server/tests/agent-browser-tools.test.ts:1060`, `server/tests/agent-browser-tools.test.ts:1140`, `server/tests/agent-browser-tools.test.ts:1201`; M6 e smoke governado real |
| RQ-09 AC1–AC4 | `server/src/agent-runtime/browser-tools.ts:518` | `server/tests/agent-browser-tools.test.ts:940`, `server/tests/agent-browser-tools.test.ts:971`, `server/tests/agent-browser-tools.test.ts:985`, `server/tests/agent-browser-tools.test.ts:1012`, `server/tests/computer-routes.test.ts:173`; Lightpanda real |
| RQ-10 AC1–AC4 | `server/src/agent-runtime/routed-provider.ts:83`, `server/src/agent-runtime/routed-provider.ts:121`, `server/src/agent-runs/service.ts:407`, `server/src/agent-runtime/contracts.ts:253`, `server/src/agent-runtime/loop.ts:750` | `server/tests/agent-routing-policy.test.ts:167`, `server/tests/agent-routing-policy.test.ts:195`, `server/tests/agent-routing-policy.test.ts:247`, `server/tests/agent-routing-policy.test.ts:258`, `server/tests/agent-routing-policy.test.ts:294`, `server/tests/agent-routing-policy.test.ts:306`, `server/tests/agent-routing-policy.test.ts:328`, `server/tests/agent-routing-policy.test.ts:369`, `server/tests/agent-routing-policy.test.ts:439`, `server/tests/agent-runtime-loop.integration.test.ts:1239`; roteador real com DB e retomada, M7 |
| RQ-11 AC1–AC4 | `server/src/agent-runs/worker.ts:55`, `server/src/config.ts:976` | `server/tests/agent-runs.integration.test.ts:239`, `server/tests/agent-runs.integration.test.ts:395`, `server/tests/config.test.ts:45` |
| RQ-12 AC1–AC3 | `docs/agentic/architecture.md:144` e documentação de isolamento | Documentação cotejada com implementação; distinção entre prova local e homologação externa neste relatório |

## Achados encerrados

- **F1 / P2:** modelo explicitamente escolhido era descartado quando igual ao padrão do deployment. `createRun` agora persiste origem da escolha em `modelPinned`, sobrescrevendo metadata arbitrário; executor conserva pin na retomada. Teste com roteador real cobre ambas as direções de tentativa de forjar metadata. M7 demonstra discriminação.
- **F2 / P3:** fallback de modo incompatível era desativado apenas com warning. Construção do roteador agora recusa essa configuração; fallback não construído continua distinto de incompatibilidade de modo. Regressão em `server/tests/agent-routing-policy.test.ts:258`.
- Revisão confirmou recusa explícita em excesso de contexto humano, proteção da condição de conclusão contra metadata forjado, ausência de retry após efeito incerto e persistência de uso nos caminhos de pausa.

## Smokes reais e limites

Main executou CLI local controlado; Chromium com fontes locais montadas; formulário pelo gateway com duas ações auditadas, zero submit, parada por mudança estrutural e takeover; Lightpanda pelo gateway lendo página pública local sem sessão. Esses smokes não constituem homologação com fornecedores pagos ou serviços externos reais.

Nenhum push, deploy, chamada paga, alteração do banco operacional ou alegação de economia monetária. Os gates são desta implementação, não reutilização de contagens históricas.

**Desvio de processo:** T3–T12 foram integradas em um único commit `3a94b94`, em vez de um commit por tarefa. Correções independentes estão em `d29e339`. Granularidade divergente foi declarada, sem reescrever histórico ou alegar sequência atômica por tarefa.

## Limpeza

[cleanup.json](evidence/cleanup.json): banco descartável encerrado, imagem temporária Lightpanda removida e snapshots/scripts/logs temporários removidos. Os três containers operacionais permaneceram rodando. Caminhos `/tmp` presentes no sensor são históricos; evidência durável está em `evidence/*.json`.
