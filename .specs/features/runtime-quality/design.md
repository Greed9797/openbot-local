# Runtime Quality Design

Spec: `.specs/features/runtime-quality/spec.md`.
Status: proposta de execução do plano integral autorizado.

## Architecture Overview

Manter Hono/Bun, Postgres, AG-UI, gateway e Playwright. O servidor continua dono da identidade, tarefa, estado e autorização. CLIs continuam transportes delegados, com contexto explícito e admissão serializada. Não adicionar framework de agentes.

Alternativas já apresentadas: evolução incremental (adotada como base), centralização num único CLI (dependência maior do fornecedor), troca de framework/multiagentes (custo sem ganho demonstrado).

## Code Reuse Analysis

| Componente | Local | Reuso |
|---|---|---|
| Histórico durável | `server/src/index.ts:541` | Fonte canônica do chat já carregada pelo runner |
| Envelope CLI | `agent-cli/src/index.ts:138` | Substituir seleção da última mensagem por contexto limitado |
| Loop durável | `server/src/agent-runtime/loop.ts` | Orçamento, contexto, decisão e conclusão |
| Contratos | `server/src/agent-runtime/contracts.ts` | Estender resultado com metadados observáveis |
| Uso persistido | `server/src/agent-runs/types.ts:81` | Contagem e campos opcionais explícitos em JSON existente |
| Ferramentas | `server/src/agent-runtime/browser-tools.ts` | Preenchimento composto e leitura pública |
| Formulário | `server/src/agent-runtime/form-extract.ts` | `extractForm` e `planFill` |
| Captura | `server/src/agent-runtime/observation.ts` | Classificação, segredo e retenção existentes |
| Navegador | `agent-computer/src/index.ts` | Snapshot/refs e ações Playwright |
| Perfis | `agent-computer/src/profiles.ts` | Contexto persistente por Bot |
| Catálogo de modelos | `server/src/agent-runtime/model-catalog.ts` | Candidatos/capabilities existentes |
| Worker | `server/src/agent-runs/worker.ts` | Limite global com lease por perfil |

## Contracts

### Contexto

- CLI recebe mensagens daquele pedido, com papéis preservados e limite total de 48.000 caracteres. Não guarda estado de conversa em variável global.
- Mensagem atual nunca é cortada. Histórico mais antigo é omitido com indicação explícita. Se conteúdo obrigatório não couber, falha antes do spawn.
- Contexto do loop inclui restrições humanas persistidas e projeção limitada de resultados úteis, sem repetir páginas completas.
- Adaptadores enviam regras no papel de sistema e conteúdo variável no papel de usuário. Não concatenar systemPrompt novamente no conteúdo variável.

### Admissão CLI

Fila FIFO abortável no processo, envolvendo prepararTurno e toda a vida do processo filho. Limpeza e liberação em finally. Cancelamento antes da admissão não modifica workspace. Sem prometer isolamento de segurança do shell.

### Conclusão

Representar pós-condições declarativas no contrato da tarefa: texto presente na página atual, URL esperada ou artefato pertencente ao run e disponível. Validar limites e pertencimento na entrada. Nunca aceitar JavaScript ou expressão arbitrária do usuário/modelo como verificador.

Executar verificação host-side após final. Ausência de prova de efeito externo usa needs_reconciliation. Resposta textual sem ação externa continua compatível. Uma observação fornecida pelo modelo não substitui observação obtida pelo host. Fechar integração nos caminhos step e delegated; não entregar apenas um helper sem consumo.

### Uso e tempo

Registrar tentativa antes da chamada. Metadados de retorno carregam usage conhecido, modelo efetivo e latência; erro preserva tentativa. Adaptadores sem usage registram desconhecido. Tarifa somente se configuração explícita já disponível ou adicionada no contrato local de custo; nenhuma tabela de preços inventada.

Tempo ativo = base persistida da retomada + delta monotônico da execução atual. Recalcular no momento da persistência. Deadline abortável acompanha chamada de modelo e ação, mantendo precedência de pausa/cancelamento do usuário.

### Observação

Screenshot por solicitação única. Reaproveitamento apenas na mesma geração; invalidação após ação/alteração. Coleta identifica coerência entre snapshot e texto; não usar Promise.all cego para leituras que podem atravessar navegação. Preservar redaction, classificação de imagens e recusa em segredo.

### Ferramentas compostas

Preencher formulário por operações sequenciais do gateway. Resolver plano uma vez, revalidar antes de cada campo e interromper se estado/estrutura invalidar o plano. Resultado parcial informa concluídos, falha e pendentes. Não devolver valores secretos nem executar submit.

Leitura pública reutiliza fetch do gateway/Lightpanda. Recusa não é motivo de fallback; falha técnica informa opção Chromium. Fallback explícito pode mudar página, portanto é ação governada. Sessão e visão permanecem Chromium.

### Política de modelos e concorrência

Roteamento opt-in no contrato de configuração do runtime/da tarefa, sem novo serviço. Modelo fixo mantém precedência. Candidatos vêm do catálogo registrado, com compatibilidade de modalidade; uma escalada máxima por decisão de roteamento autorizada. Registrar escolha e motivo. A integração deve chegar à criação/execução real de tarefas, não apenas à função seletora.

Worker mantém default 1, limite configurável 1–4 e lease por perfil. CLI serializado pode limitar throughput mesmo com worker maior; documentar em vez de contornar fila. Não ativar concorrência maior no ambiente do usuário automaticamente.

## Data Models

Preferir campos JSON existentes de configuração, budget, usage e checkpoint. Campos novos devem ter leitura compatível para registros antigos e saída explícita para consumo desconhecido. Alteração relacional só se consulta/constraint exigir; antes dela ler regras Postgres e criar migração reversível. Não alterar banco operacional durante esta entrega.

## Error Handling Strategy

| Erro | Resultado |
|---|---|
| Prompt atual acima do limite | Falha explícita antes de chamar modelo |
| Turno em fila cancelado | Removido, sem spawn |
| Deadline ativo | BUDGET_EXCEEDED; próximo efeito não executado |
| Efeito externo incerto | needs_reconciliation |
| Snapshot obsoleto | Nova observação; nenhuma repetição cega |
| Campo intermediário falhou | Resultado parcial; restantes não executados |
| Fetch negado | Recusa definitiva, sem fallback |
| Candidato incompatível/ausente | Erro explícito, sem substituição silenciosa |
| Usage indisponível | Desconhecido, não zero |

## Risks & Concerns

| Risco | Evidência | Mitigação |
|---|---|---|
| Perda de memória | `agent-cli/src/index.ts:138` | Contexto canônico limitado e teste de continuação |
| Corrida no workspace | `agent-cli/src/index.ts:283` | Reproduzir concorrência; fila abortável na admissão |
| Sucesso sem prova | `server/src/agent-runtime/loop.ts:595` | Pós-condições host-side e reconciliação |
| Dupla contagem temporal | `server/src/agent-runtime/loop.ts:354` | Reprodução com relógio controlado antes da correção |
| Resultado de ferramenta perdido | `server/src/agent-runtime/loop.ts:73` | Projeção limitada com proveniência |
| Imagens persistentes após pedido | `server/src/agent-runtime/loop.ts:821` | Consumo único de wantImage |
| Estado misturado entre leituras | `server/src/agent-runtime/observation.ts:44` | Coerência de versão, sem paralelização cega |
| Testes assumem catálogo exato antigo | `server/tests/agent-browser-tools.test.ts:36` | Atualizar somente contrato legitimamente ampliado; manter proibição de shell/JS |
| Integração usa DATABASE_URL operacional como fallback | `server/tests/agent-runtime-loop.integration.test.ts:29` | Rodar com banco de teste dedicado explícito |
| Docs confundem serviço e perfil | `server/src/computer/provider.ts:50` | Corrigir descrição e provar isolamento real |

## Verification

Testes derivam da spec, não de estrutura interna. Probes de regressão antes de cada correção. Smoke real do CLI com executável controlado local quando credenciais não forem necessárias; navegador local com fixture sem publicação. Teste de modelo remoto pago não faz parte de autorização atual.

Verificador independente após último commit, sensor em cópia isolada e relatório com cobertura por AC. Mudanças no mesmo módulo são sequenciais. Nenhum autor valida sua própria implementação como verificação independente.
