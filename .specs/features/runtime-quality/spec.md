# Runtime Quality Specification

Status: implementação integral autorizada, com delegação independente.
Base: `824893b`, branch `local-fork`.
Fonte: `docs/agentic/architecture-improvement-proposal.md`.

## Problem Statement

O motor CLI perde o histórico; o runtime confunde resposta final com resultado comprovado. Consumo, tempo, observação e concorrência precisam de contratos consistentes antes de ampliar autonomia.

## Goals

- Preservar continuidade sem misturar conversas.
- Concluir tarefas com evidência e sem repetição de efeitos incertos.
- Medir consumo real e eliminar processamento redundante.
- Executar o plano completo P0–P2 mantendo gateway e controle humano.

## Out of Scope

| Feature | Reason |
|---|---|
| Push, deploy e banco de produção | Autorização atual é local |
| Contratar modelo, usar cota paga em homologação | Precisa de autorização de conta/orçamento |
| Novo framework, Redis, banco vetorial, multiagentes permanentes | Relatório recomenda reutilização |
| Upload/download/abas/hover novos | Relatório condiciona a casos concretos ainda não definidos; ferramentas existentes continuam funcionando |
| Percentual garantido de economia | Depende de baseline representativa |

## Assumptions & Open Questions

| Assumption / decision | Chosen default | Rationale | Confirmed? |
|---|---|---|---|
| Escopo | Todos os achados P0–P2, por etapas | Escolha explícita do usuário | Sim |
| Arquitetura | Evolução incremental do servidor e adaptadores | Preserva contratos existentes | Proposta recomendada aceita como base |
| Memória CLI | Histórico enviado pelo servidor, sem sessão nativa nova | Evita estado paralelo e vínculo opaco |
| Limite de contexto CLI | 48.000 caracteres por envelope, mensagem atual preservada; excedente irredutível recusado | Limite determinístico sem depender de tokenizer do fornecedor |
| Concorrência CLI | Serializar entrada por processo antes de preparar workspace | Menor correção que impede corrida, sem fingir sandbox |
| Conclusão | Pós-condições explícitas quando disponíveis; efeito externo não comprovado exige reconciliação | Não inferir sucesso de prosa do modelo |
| Roteamento | Fixo por padrão; opt-in com candidatos configurados, no máximo uma escalada | Preserva escolha e limita custo |
| Custo | Valor desconhecido representado como null/indisponível | CLI não garante usage nem tarifa |
| Worker | Default 1; limite configurável de 1 a 4, mantendo exclusão por perfil | Evita aumento involuntário de consumo |
| Aprovação | Sempre no caminho governado, sem submit implícito | Segurança não é otimização opcional |
| Testes de integração | Banco isolado, nunca fallback para banco da pessoa | Preserva dados e runs existentes |

**Open questions:** none — decisões não especificadas foram registradas como defaults conservadores; usuário pode substituí-las antes de Execute.

## User Stories

### P1: Memória de conversa — RQ-01

Como usuário, quero perguntar sobre dados anteriores sem repeti-los.

**Acceptance Criteria**:
1. WHEN um pedido CLI trouxer histórico textual THEN o serviço SHALL incluir as mensagens anteriores que couberem no envelope e a mensagem atual com identificação de papel.
2. WHEN dois pedidos de threads diferentes forem processados THEN o serviço SHALL construir cada contexto somente das mensagens daquele pedido.
3. IF histórico antigo ultrapassar o limite THEN o serviço SHALL preservar a mensagem atual e sinalizar explicitamente a omissão de histórico antigo.
4. IF a mensagem atual sozinha ultrapassar o limite THEN o serviço SHALL recusar antes de iniciar o CLI, sem truncar silenciosamente a solicitação.

**Independent Test**: endereço no primeiro turno recuperável no segundo; thread diferente sem endereço; envelope excedido explícito.

### P1: Isolamento de execução CLI — RQ-02

**Acceptance Criteria**:
1. WHILE um turno estiver preparando ou usando o workspace o serviço SHALL manter outro turno aguardando antes de modificar configuração, instruções ou skills.
2. WHEN um turno aguardando for cancelado THEN o serviço SHALL removê-lo sem iniciar processo nem interromper o turno ativo.
3. WHEN um turno ativo terminar ou falhar THEN o serviço SHALL liberar o próximo turno não cancelado.

**Independent Test**: dois turnos com concessões distintas observam seus próprios arquivos; falha não bloqueia fila.

### P1: Resultado verificável — RQ-03

**Acceptance Criteria**:
1. WHEN uma tarefa com pós-condição explícita receber decisão final THEN o runtime SHALL avaliar a condição contra observação ou artefato real antes de registrar succeeded.
2. IF houve ação com possível efeito externo e a condição não puder ser confirmada THEN o runtime SHALL registrar needs_reconciliation sem repetir a ação.
3. WHEN uma tarefa puramente textual sem efeito externo terminar THEN o runtime SHALL permitir conclusão sem screenshot obrigatório.
4. IF a decisão do modelo fornecer somente prosa alegando sucesso externo THEN o runtime SHALL não tratar essa prosa como comprovação do efeito.

**Independent Test**: sucesso declarado sem confirmação não produz succeeded; confirmação verdadeira permite concluir.

### P1: Consumo por tentativa — RQ-04

**Acceptance Criteria**:
1. WHEN duas tentativas de modelo falharem e a terceira responder THEN o uso persistido SHALL registrar três chamadas.
2. WHEN um provedor fornecer tokens de entrada, saída ou cache THEN o runtime SHALL preservar os valores reportados com identificação do provedor e modelo efetivo.
3. IF o provedor não fornecer consumo ou tarifa THEN o runtime SHALL registrar o valor correspondente como desconhecido, não zero estimado.
4. The runtime SHALL não persistir prompts, cookies ou credenciais na telemetria de consumo.

**Independent Test**: sequência falha/falha/sucesso; usage conhecido versus ausente, sem segredo nos eventos.

### P1: Orçamento temporal — RQ-05

**Acceptance Criteria**:
1. WHEN três intervalos ativos de 1.000 ms forem executados THEN o runtime SHALL registrar 3.000 ms de tempo ativo acumulado.
2. WHILE a tarefa estiver esperando uma pessoa o runtime SHALL excluir esse intervalo do tempo ativo.
3. WHEN o deadline ativo expirar durante chamada de modelo THEN o runtime SHALL abortar a chamada e registrar BUDGET_EXCEEDED sem executar a próxima ação.
4. WHEN pausa ou cancelamento ocorrer durante chamada THEN o runtime SHALL preservar o estado solicitado pela pessoa.

**Independent Test**: relógio controlado e operação pendente abortável.

### P1: Memória útil e prompt sem duplicação — RQ-06

**Acceptance Criteria**:
1. WHEN um adaptador montar uma requisição com papel de sistema THEN o envelope SHALL conter as instruções de sistema uma única vez.
2. WHEN uma ferramenta retornar resultados estruturados úteis THEN a decisão seguinte SHALL receber esses resultados com proveniência de ferramenta, sujeitos a limite explícito de contexto.
3. WHEN uma mensagem da pessoa for consumida numa decisão THEN passos seguintes SHALL conservar sua restrição no contexto de trabalho até substituição explícita ou término do run.
4. The context builder SHALL manter dados da página e resultados de ferramentas identificados como dados não confiáveis, distintos das instruções da pessoa.

**Independent Test**: plan_form entrega assignments na próxima decisão; restrição sobrevive a mais de um passo; sem duplicação de sistema.

### P1: Observação orientada à necessidade — RQ-07

**Acceptance Criteria**:
1. WHEN um modelo pedir uma screenshot THEN o runtime SHALL oferecer a imagem autorizada somente na observação seguinte, salvo novo pedido explícito.
2. WHEN uma tarefa não pedir visão THEN o runtime SHALL não enviar imagens ao provedor.
3. IF controle humano ou segredo impedir captura THEN o runtime SHALL manter a recusa existente e não capturar por outro caminho.
4. WHEN dados de observação forem reaproveitados THEN o runtime SHALL vincular o reaproveitamento à mesma geração e invalidá-lo após alteração de página.
5. IF snapshot e texto pertencerem a páginas diferentes THEN o runtime SHALL rejeitar a observação incoerente e obter observação nova antes de agir.

**Independent Test**: sequência screenshot→ação→decisão; navegação durante coleta; stale snapshot recusado.

### P1: Preenchimento composto — RQ-08

**Acceptance Criteria**:
1. WHEN receber pares de campos válidos de formulário estável THEN a ferramenta composta SHALL preencher os campos por ações governadas sem nova chamada LLM por campo.
2. IF um campo falhar ou alterar a estrutura THEN a ferramenta SHALL parar e devolver resultado parcial identificando campos concluídos e não executados.
3. The ferramenta composta SHALL nunca executar submit nem pressionar Enter implicitamente.
4. IF o controle passar à pessoa durante preenchimento THEN a ferramenta SHALL interromper antes do próximo campo.

**Independent Test**: formulário estável, re-render após primeiro campo, falha parcial e controle humano.

### P2: Leitura pública barata — RQ-09

**Acceptance Criteria**:
1. WHEN uma tarefa pedir leitura pública sem sessão THEN o catálogo step SHALL oferecer fetch governado pelo caminho Lightpanda existente.
2. IF fetch for negado pela política THEN o runtime SHALL preservar a recusa sem tentar Chromium para contorná-la.
3. IF fetch falhar tecnicamente THEN o runtime SHALL oferecer fallback explícito para Chromium sujeito às mesmas permissões.
4. WHEN a tarefa exigir sessão autenticada ou pixels THEN o runtime SHALL manter Chromium como caminho de leitura e interação.

**Independent Test**: fetch público, recusa definitiva, indisponibilidade técnica e página autenticada.

### P2: Roteamento explícito — RQ-10

**Acceptance Criteria**:
1. WHEN política de roteamento estiver ausente THEN o runtime SHALL manter provedor e modelo explicitamente escolhidos sem substituição.
2. WHERE política opt-in estiver configurada o runtime SHALL selecionar somente candidatos registrados compatíveis com a modalidade necessária.
3. IF candidato econômico falhar conforme política autorizada THEN o runtime SHALL permitir no máximo uma escalada registrada para candidato configurado.
4. IF não existir candidato autorizado compatível THEN o runtime SHALL informar indisponibilidade sem escolher outro modelo silenciosamente.

**Independent Test**: modo fixo, visão incompatível, uma escalada e esgotamento.

### P2: Concorrência entre perfis — RQ-11

**Acceptance Criteria**:
1. WHEN configuração de concorrência estiver ausente THEN o worker SHALL executar no máximo um run ativo.
2. WHERE concorrência estiver configurada entre 1 e 4 o worker SHALL respeitar esse limite global.
3. WHILE um run possuir lease do perfil o worker SHALL impedir outra ação concorrente nesse perfil.
4. IF configuração estiver fora de 1 a 4 THEN o servidor SHALL rejeitar a configuração no boot.

**Independent Test**: perfis iguais serializados, distintos progridem, limite e configuração inválida.

### P2: Operação e avaliação — RQ-12

**Acceptance Criteria**:
1. The documentação operacional SHALL distinguir isolamento por perfil de isolamento por processo/container.
2. The documentação SHALL descrever os defaults efetivos de memória, conclusão, leitura, roteamento e concorrência implementados.
3. WHEN a avaliação local terminar THEN o relatório SHALL separar testes locais de resultados históricos e de homologação externa não executada.

**Independent Test**: documentação cotejada com configurações, smoke local e relatório de validação independente.

## Edge Cases

- IF um efeito externo for incerto THEN o runtime SHALL não repetir a ação automaticamente.
- IF uma autorização ou skill tiver sido revogada THEN a próxima execução SHALL não usar a concessão anterior.
- IF uma API receber identidade não autorizada THEN o sistema SHALL preservar a recusa existente.
- WHEN o servidor reiniciar THEN o runtime SHALL retomar apenas do estado persistido e respeitar os leases existentes.

## Implicit Requirements Sweep

| Dimensão | Contrato |
|---|---|
| Validação e limites | RQ-01, RQ-08, RQ-10, RQ-11 |
| Falha e resultados parciais | RQ-02, RQ-03, RQ-08, RQ-09 |
| Idempotência e repetição | RQ-03 e Edge Cases |
| Autorização e limites públicos | Gateway existente preservado; nenhum endpoint público novo sem guarda |
| Concorrência e ordem | RQ-02, RQ-11 |
| Ciclo de vida | Histórico canônico existente; artefatos mantêm retenção atual; sem nova memória global |
| Observabilidade | RQ-04, RQ-05, RQ-12 |
| Dependência externa | RQ-09, RQ-10 |
| Transições | RQ-03, RQ-05 |

## Requirement Traceability

| Requirement ID | Story | Phase | Status |
|---|---|---|---|
| RQ-01 | Memória CLI | Contexto | Verified |
| RQ-02 | Isolamento CLI | Contexto | Pending |
| RQ-03 | Conclusão | Confiabilidade | Pending |
| RQ-04 | Consumo | Confiabilidade | Pending |
| RQ-05 | Relógio | Confiabilidade | Pending |
| RQ-06 | Contexto útil | Contexto | Pending |
| RQ-07 | Observação | Eficiência | Pending |
| RQ-08 | Formulário | Eficiência | Pending |
| RQ-09 | Leitura pública | Eficiência | Pending |
| RQ-10 | Roteamento | Operação | Pending |
| RQ-11 | Concorrência | Operação | Pending |
| RQ-12 | Documentação | Operação | Pending |

## Success Criteria

- Todas as ACs com evidência de resultado observável e gates verdes.
- Smoke local do CLI e do ciclo de navegador sem ação externa sensível.
- Commits atômicos e verificador independente com relatório PASS e sensor de regressão.
- Nenhuma alegação de economia monetária ou homologação paga sem medição autorizada.
