# OpenBot — análise e proposta de evolução

Data: 2026-09-12. Base: `local-fork`, commit `824893b`; árvore limpa no início da análise.
Status: proposta para decisão, não implementação aprovada.

## 1. Veredito

Preservar a arquitetura existente. O maior retorno imediato está em contexto/memória, comprovação de resultado, isolamento do executor CLI e medição de consumo — não em trocar Playwright, adicionar modelos ou criar vários agentes.

O sistema já tem tarefas duráveis, controle humano, gateway de ações, aprovação, navegador persistente e múltiplos transportes de modelo. Entretanto, os dois caminhos de execução não oferecem a mesma memória, observabilidade e controle do ciclo. Isso faz a qualidade percebida depender do motor escolhido.

Objetivo proposto: aumentar a proporção de tarefas corretamente concluídas por unidade de custo, sem ampliar permissões nem reduzir aprovação humana.

## 2. Escopo e evidência

Análise direcionada do runtime, montagem de prompts, adaptador OpenAI-compatible, transporte delegado, serviço CLI, ferramentas de navegador, perfis Playwright e documentação de entrega. Não é auditoria exaustiva de frontend, banco, autenticação, Telegram ou de todas as implementações de provedores.

Não foram lidos segredos, alteradas configurações, executados modelos pagos, publicadas ações ou modificados dados de usuários. Dois probes locais executaram funções reais com entradas sintéticas, sem navegador, rede de modelo ou banco:

- `perguntaDoTurno`: três mensagens, incluindo um endereço na primeira e uma pergunta sobre ele na última. Retorno: somente a última pergunta; endereço ausente.
- `systemPrompt` + `userPrompt`: instrução de sistema com 1.222 caracteres no exemplo; `userPrompt` começa com a mesma instrução. O adaptador OpenAI-compatible também a envia no papel `system`.

Ambos os probes encerraram com código 0. Não representam benchmark de latência, fatura ou taxa de sucesso.

O relatório anterior registra 1.193 testes passando e uma bateria de turno único com 40/44 casos aprovados. Esses números são históricos, não reexecutados nesta análise. A mesma fonte registra falhas de memória, ambiguidade e ação sem contexto suficiente (`delivery-report.md:161`, `delivery-report.md:173`, `delivery-report.md:178`).

Não existe `.specs/STATE.md` nesta árvore. Esta entrega não cria aprovação retroativa, não marca feature implementada e não aplica gates de conclusão de implementação. O próximo ciclo TLC deve produzir spec de um recorte aprovado, não de uma reescrita inteira.

## 3. Arquitetura atual

### Caminho de tarefas

Web/Telegram/API → serviço de tarefas → Postgres/leases → worker → loop de observação/decisão → aprovação → catálogo de ferramentas → gateway/política/auditoria → agent-computer → Playwright/Chromium.

Evidência: `server/src/agent-runtime/loop.ts:264`, `server/src/agent-runtime/loop.ts:618`, `server/src/agent-runtime/browser-tools.ts:280`, `server/src/index.ts:759`.

### Caminho delegado e chat

Chat AG-UI ou tarefa delegada → agent-cli/agent-codex → ciclo interno do CLI → ferramentas MCP → gateway → navegador. O executor externo decide suas próprias chamadas intermediárias; o loop do servidor não governa cada decisão interna como faz no modo step.

Evidência: `agent-cli/src/index.ts:453`, `server/src/agent-runtime/providers/codex-delegated.ts:155`. Não presumir que um teste do chat valida toda a máquina de estados de tarefas.

### O que preservar

- Postgres e leases existentes; não introduzir outra fila sem gargalo medido.
- Aprovação antes de ação sensível, consumo único e reconciliação de efeitos incertos.
- Gateway e auditoria compartilhados; não expor Playwright cru ao modelo.
- Refs de snapshot, rejeição de refs obsoletas e `fill` para substituir valores.
- Perfis persistentes e intervenção humana para senha, CAPTCHA e 2FA.
- Índice de skills com carregamento sob demanda: já implementado em `agent-cli/src/index.ts:199`.
- Escolha explícita de provedor/modelo; não trocar silenciosamente o modelo do usuário.

### Correção importante da documentação

O provider chamado `shared` afirma que sessões e logins são compartilhados (`server/src/computer/provider.ts:50`), mas o código atual de `agent-computer` mantém diretório e contexto persistente por `botId` (`agent-computer/src/profiles.ts:153`, `agent-computer/src/profiles.ts:197`). O provider também envia o identificador do Bot (`server/src/computer/provider.ts:110`).

Portanto, distinguir **serviço/processo compartilhado** de **perfil de navegador compartilhado**. Há isolamento lógico de perfil no código; isso não equivale a isolamento de segurança entre processos/containers. Não atribuir todos os problemas de concorrência a um suposto único perfil.

## 4. Achados priorizados

### P0 — Contexto da conversa é descartado pelo CLI

**Fato, reproduzido:** `perguntaDoTurno` seleciona somente a última mensagem do usuário (`agent-cli/src/index.ts:138`). A execução recebe esse texto (`agent-cli/src/index.ts:477`).

**Impacto:** perguntas de continuação parecem perda de inteligência; repetir instruções custa tempo e contexto. Trocar para modelo mais caro não recupera dados que não foram enviados.

**Proposta:** usar histórico durável do servidor como fonte canônica; montar contexto limitado por orçamento com objetivo, restrições, fatos confirmados e mensagens recentes. Não começar com banco vetorial. Sessão nativa do CLI é alternativa posterior, desde que exista vínculo explícito por usuário/Bot/thread e reconciliação após restart ou troca de modelo.

**Aceitação:** quando o usuário informar um dado e perguntar depois, o motor deve recuperá-lo na mesma thread; outra thread não deve recebê-lo. Após restart, a política de continuidade deve permanecer igual. Conteúdo não deve ser truncado sem indicação.

### P0 — Sucesso depende da declaração do modelo

**Fato estático:** decisões `final` ou `delegated` viram `succeeded`; `evidence` é opcional (`server/src/agent-runtime/loop.ts:595`). No adaptador OpenAI-compatible, texto sem tool call vira `final` (`server/src/agent-runtime/providers/openai-compatible.ts:135`).

**Impacto:** terminar geração não prova que publicou, preencheu, salvou ou extraiu corretamente. Regras no prompt ajudam, mas não impõem esse contrato.

**Proposta:** separar resposta concluída de objetivo verificado. Tarefas com efeito externo precisam de pós-condição observável: confirmação, identificador, estado de campo ou artefato acessível. Usar checagem determinística quando disponível; revisão por modelo somente para resultado semântico que não tenha verificador simples.

**Aceitação:** se o modelo disser “concluído” sem a pós-condição, o sistema não deve declarar efeito externo confirmado. Se a ação puder ter ocorrido mas não houver confirmação, deve pedir reconciliação, sem repeti-la. Conversa puramente textual não deve exigir screenshot artificial.

### P0 — Workspace CLI compartilhado é risco para concorrência

**Fato estático:** `WORKSPACE` é global ao serviço (`agent-cli/src/index.ts:50`); cada turno reescreve configuração e instruções e remove/recria as skills (`agent-cli/src/index.ts:242`, `agent-cli/src/index.ts:283`). O endpoint inicia o run diretamente (`agent-cli/src/index.ts:696`).

**Risco, ainda não reproduzido com duas requisições:** turnos concorrentes podem disputar configuração, declaração de execução e skills. `concurrency: 1` do worker não demonstra serialização das entradas de chat no serviço CLI.

**Proposta:** antes de aumentar concorrência, impor exclusão mútua no limite do serviço que compartilha workspace ou separar diretórios por identidade/thread, com material de autorização isolado por run. Começar pela opção mais simples compatível com o volume de uso. Separar diretório sozinho não prova isolamento do processo ou das credenciais.

**Aceitação:** dois turnos simultâneos com skills e identidades diferentes não podem ler configuração um do outro; revogação continua válida no próximo turno; cancelamento não encerra o processo alheio.

### P1 — Consumo não basta para otimizar custo

**Fato estático:** `RunUsage` registra passos, tempo, modelCalls e toolCalls, sem tokens, cache ou valor monetário (`server/src/agent-runs/types.ts:81`). O retry chama o modelo várias vezes, mas o contador cresce uma vez após decisão (`server/src/agent-runtime/loop.ts:511`, `server/src/agent-runtime/loop.ts:543`).

**Proposta:** medir por tentativa: provedor/modelo efetivo, latência, motivo de retry, tokens de entrada/saída/cache quando fornecidos, duração de ferramentas e custo conhecido ou estimado com origem identificada. Consumo não informado pelo CLI deve ser `desconhecido`, nunca zero.

**Aceitação:** duas tentativas falhas seguidas de sucesso contam três chamadas; ausência de usage não gera custo fictício; logs não armazenam prompt, cookies ou segredos por padrão.

### P1 — Contabilidade temporal merece correção antes de metas de velocidade

**Evidência estática:** `started` é fixado na entrada da execução (`loop.ts:313`), mas cada iteração soma `used.activeMs` atualizado ao tempo desde essa mesma entrada (`loop.ts:354`); o valor é persistido em `loop.ts:548` e `loop.ts:756`.

**[INFERENCE]** Há dupla contagem do trecho já acumulado em iterações sucessivas. Além disso, `elapsed` é calculado antes da chamada de modelo/ferramenta, não no encerramento delas. Isso pode distorcer orçamento e métricas. Não foi reproduzido contra banco nesta análise.

**Proposta:** acumular deltas monotônicos ou somar base imutável da retomada ao tempo da execução atual; aplicar deadline durante operações, não apenas no topo do loop.

**Aceitação:** relógio controlado com três intervalos de 1 s deve registrar 3 s, não soma cumulativa repetida; espera humana deve ficar fora; timeout do run deve interromper operação longa conforme contrato.

### P1 — Contexto é grande onde não precisa e pequeno onde importa

**Fatos:** o prompt repete regras do sistema no exemplo OpenAI-compatible (`prompt.ts:142`, `providers/openai-compatible.ts:69`). Em contrapartida, `historyOf` preserva nome/status/summary, mas não os campos de `executionResult.result` (`loop.ts:73`). Ferramentas como `plan_form` colocam atribuições justamente em `result` (`browser-tools.ts:365`).

**[INFERENCE]** O modelo pode perder resultados úteis de planejamento/extracão entre passos e voltar a descobri-los, embora receba novamente instruções e página.

**Proposta:** eliminar duplicação por adaptador; criar memória de trabalho estruturada com dados selecionados, proveniência e restrições. Não repetir todo tool result nem todo histórico. Preservar distinção entre dados da página e ordens do usuário.

**Aceitação:** resultado útil de uma ferramenta deve estar disponível na decisão seguinte sem refazer a ferramenta; instrução de sistema deve aparecer uma vez no envelope apropriado; dado não confiável não ganha autoridade ao ser resumido.

### P1 — Observação e visão geram trabalho repetido

**Fatos:** cada observação executa `control → snapshot → read` sequencialmente (`observation.ts:44`). `readablePageText` clona o body antes de extrair texto (`agent-computer/src/index.ts:213`). `read_page` e `snapshot_page` também estão disponíveis como ferramentas. Após screenshot, `wantImage` vira `true` e não há reset no restante do loop (`loop.ts:316`, `loop.ts:821`).

**Impacto potencial:** chamadas redundantes, DOM percorrido repetidamente e imagens nos passos seguintes sem novo pedido. Sem medição de latência/tokens, não atribuir percentual de desperdício.

**Proposta:** observação coerente e sob demanda: refs sempre que ação precisar, texto completo quando leitura precisar, imagem quando houver necessidade visual. Usar versão/hash para reaproveitar dados sem reaproveitar refs inválidas. Screenshot deve ter política explícita: apenas próximo passo ou persistência justificada por tarefa visual.

Não paralelizar snapshot e leitura cegamente: uma navegação no meio pode misturar páginas. Preferir captura agrupada no serviço de navegador com identificação de versão e invalidação.

**Aceitação:** tarefa textual não envia imagens; pedido isolado de screenshot não envia imagens indefinidamente; DOM alterado invalida referências; observação truncada informa limite e permite recuperação direcionada.

### P1 — Uma decisão por campo encarece formulários

**Fatos:** prompt exige uma ação por resposta (`prompt.ts:32`); `plan_form` planeja, mas não executa preenchimento (`browser-tools.ts:365`).

**Proposta:** manter ações unitárias como base e acrescentar operação composta estreita de preenchimento, reutilizando `extractForm`/`planFill`. Cada campo continua governado, com revalidação de estado e resultado parcial explícito. Nenhum submit implícito. Se um campo provocar mudança estrutural, interromper e observar de novo.

**Aceitação:** formulário estável com vários campos não precisa de uma decisão LLM por campo; erro intermediário identifica o que foi preenchido; publicação continua exigindo aprovação; nenhum campo é preenchido por ref de outra geração.

### P2 — Lightpanda e catálogo devem seguir a necessidade

**Fato documentado:** Lightpanda existe no caminho MCP, mas não faz parte do catálogo step; a observação step é Chromium (`docs/agentic/architecture.md:53`, `observation.ts:80`).

**Proposta:** leitura pública sem sessão pode usar fetch governado/Lightpanda; login, SPA com estado, formulário e pixels permanecem em Chromium. Reaproveitar gateway e guardas de destino. Falha de extração deve permitir fallback explícito; não tentar Lightpanda para screenshot.

O índice de skills já é lazy. Só adicionar seleção por tarefa se o tamanho real do índice justificar; registrar skills selecionadas e garantir que restrições obrigatórias não sejam omitidas.

**Aceitação:** leitura pública e tarefa autenticada usam rotas apropriadas; fallback não contorna política; skill revogada não aparece no contexto seguinte.

### P2 — Mais throughput exige limites, não apenas mais workers

**Fato:** worker está configurado com concorrência 1 (`server/src/index.ts:759`); perfis do navegador são separados por Bot, mas serviço e recursos podem ser compartilhados.

**Proposta:** preservar serialização por perfil; permitir concorrência entre perfis só após resolver workspace CLI e medir memória/CPU. Separar espera humana de execução ativa. Considerar limite de navegadores ociosos e fechamento controlado preservando perfil quando uso real mostrar necessidade.

**Aceitação:** tarefas do mesmo perfil nunca agem ao mesmo tempo; perfis independentes podem progredir sem mistura de dados; saturação forma fila, não OOM. Aumentar workers pode melhorar vazão, não necessariamente latência individual.

## 5. Arquitetura proposta e alternativas

### Recomendada: evolução incremental do runtime existente

Entrada → contexto canônico → decisão com orçamento → ação governada → observação/pós-condição → resultado verificável.

Manter dois transportes, mas aproximar seus contratos de contexto, autorização, conclusão e telemetria. O servidor governa a tarefa; o CLI é executor delegado, não prova independente de sucesso.

1. Chat simples não abre navegador sem necessidade.
2. Tarefa define objetivo, restrições, recursos autorizados e condição de conclusão.
3. Contexto preserva instruções e resultados úteis sem enviar tudo.
4. Ação passa pelo gateway independentemente do modelo.
5. Recuperação distingue erro sem efeito, efeito confirmado e efeito incerto.
6. Política de modelos é explícita e opt-in: fixo ou roteável.

### Alternativas para decisão

| Abordagem | Vantagem | Custo/risco | Parecer |
|---|---|---|---|
| Evoluir servidor e adaptadores atuais | Reutiliza persistência, UI, gateway e testes | Precisa reduzir diferenças entre motores | Recomendada |
| Centralizar execução em um único CLI | Menos adaptadores ativos | Dependência de sessões, limites e permissões do fornecedor | Aceitável para uso pessoal restrito, não resolve governança sozinho |
| Migrar para outro framework ou multiagentes | Flexibilidade adicional | Migração, novos estados e maior consumo antes de resolver defeitos atuais | Não recomendada agora |

Não há razão demonstrada para adicionar Redis, banco vetorial, modelo local grande ou microserviços de planner/critic/executor neste momento.

## 6. Qualidade, custo e seleção de modelos

Métrica principal: **custo por tarefa corretamente concluída**, não preço por milhão de tokens isolado.

- API: somar consumo faturável de entrada, saída e cache conforme tarifa/versionamento do fornecedor.
- CLI por assinatura: registrar cota/limites disponíveis, falhas por rate limit e parcela de assinatura explicitamente alocada. Sem token usage, não inventar equivalente em dólares.
- Operação: incluir infraestrutura e tempo de intervenção humana, separadamente do custo de modelo.
- Comparação: mesma classe de tarefa, dados, versão de prompt, permissões e critério de sucesso.

Roteamento proposto, somente quando autorizado:

| Necessidade | Estratégia |
|---|---|
| Campo conhecido, transformação ou checagem simples | Código determinístico existente |
| Extração textual bem delimitada | Modelo econômico aprovado pela bateria |
| Planejamento ambíguo ou recuperação difícil | Modelo de maior capacidade, com limite de escaladas |
| Canvas ou conteúdo só visual | Modelo com visão, captura autorizada |
| Ação irreversível ou destino sensível | Aprovação humana, não “modelo mais confiante” |

Não afirmar que um modelo específico é melhor/barato sem avaliação na conta e workload reais. Um modelo barato que exige três tentativas pode custar mais que outro que conclui de primeira.

Metas iniciais propostas, não economias já medidas: reduzir chamadas por formulário e tokens por tarefa em comparação pareada; não reduzir taxa de conclusão; zero ação sensível não autorizada nos cenários de segurança. Percentuais devem ser definidos depois de uma baseline representativa.

## 7. Autonomia semelhante a um assistente de trabalho

As referências a GPT, Claude Cowork e Grok são tratadas como expectativa de produto, não conhecimento de suas arquiteturas internas nem promessa de equivalência.

O salto necessário é completar um ciclo de trabalho confiável:

| Capacidade | Evolução necessária |
|---|---|
| Entender continuação de conversa | Contexto canônico por thread |
| Saber quando perguntar | Bloqueio por dado obrigatório ausente ou instrução conflitante |
| Trabalhar sem supervisão constante | Pós-condições, limites e recuperação por classe de erro |
| Executar ações com segurança | Autorizações por ação/destino/escopo, não consentimento genérico |
| Entregar material útil | Artefato real e verificável; não somente texto dizendo que criou |
| Retomar após falha | Checkpoint com efeito conhecido, sem repetir publicação |
| Explicar o que fez | Linha de execução com evidência, consumo e intervenção |

Autonomia não deve significar remover confirmações. Deve significar executar o que foi autorizado, perguntar apenas quando o resultado muda e parar quando não houver prova segura para continuar.

Uploads, downloads, abas e hover podem entrar como recortes governados conforme casos prioritários. Não adicionar toda a superfície do Playwright de uma vez. Arquivos exigem limites de path/tamanho/tipo, controle de destino e tratamento seguro de conteúdo recebido.

## 8. Ordem recomendada de entrega

Esta é uma sequência de recortes para especificação, não `tasks.md` aprovado:

1. **Memória e continuidade:** resolver perda de contexto no CLI e preservar resultados úteis no modo step.
2. **Confiabilidade e isolamento:** pós-condições de conclusão e proteção de workspace concorrente. Pré-requisito para autonomia ampliada.
3. **Baseline confiável:** corrigir relógio/contagem e registrar consumo por tentativa e fase.
4. **Eficiência sem regressão:** eliminar prompt duplicado, controlar visão e observação redundante.
5. **Operações compostas e roteamento:** formulário sem submit, leitura pública barata e modelos opt-in, aprovados por avaliação pareada.
6. **Escala e novas superfícies:** concorrência entre perfis, arquivos/abas conforme demanda, e homologação real de canais e sites autorizados.

Recortes 1–3 têm prioridade sobre novos provedores. Não condicionar correção de contexto à implantação de um sistema grande de observabilidade.

## 9. Validação proposta

Stack de testes existente: Bun. Reutilizar arquivos atuais e bateria; não criar uma segunda infraestrutura de avaliação.

- Memória: mesma thread, thread diferente, restart, mudança de modelo, instruções conflitantes.
- Conclusão: texto de sucesso sem efeito real, confirmação tardia, resposta perdida após submit e retomada sem duplicação.
- Concorrência: dois turnos CLI com identidades/skills diferentes; um cancelado enquanto o outro continua.
- Consumo: retries contabilizados, usage ausente, relógio monotônico, tempo humano excluído.
- Navegador: DOM re-renderizado, refs stale, formulário parcial, canvas, Lightpanda sem sessão e fallback governado.
- Segurança: conteúdo de página tentando mudar objetivo, segredo solicitado, aprovação expirada e destino proibido.
- Qualidade de geração: correção factual, satisfação das restrições, evidência, completude e ausência de ação desnecessária. Julgamento semântico separado das verificações determinísticas.

Comandos candidatos após cada implementação: `bun test agent-cli/tests/cli.test.ts`, `bun test server/tests/agent-providers.test.ts server/tests/agent-observation.test.ts server/tests/agent-browser-tools.test.ts`; testes de integração do loop exigem banco de teste isolado e a configuração já usada pelo projeto.

A bateria de conversas deve voltar a rodar após a mudança de memória. Não considerar apenas as quatro listas de turno único como prova de continuidade. Testes com serviços/modelos reais devem usar conta e ambiente autorizados, orçamento definido e tarefas sem publicação externa automática.

Comparação de desempenho: medir p50/p95 de tempo total, tempo de modelo, observação e ferramentas; chamadas, tokens quando disponíveis, correções, intervenções e taxa de sucesso por classe. Não apresentar p95 confiável a partir de poucos turnos. Manter cenários de avaliação fora dos exemplos usados para ajustar prompts.

Cada recorte aprovado deve seguir TLC: ACs verificáveis → implementação com gate → commit atômico → verificação independente. Esta análise não executou nem aprovou essas implementações.

## 10. Fontes

Evidência local identificada por arquivo:linha nas seções acima. Números históricos vêm de `docs/agentic/delivery-report.md`, não de nova homologação.

Documentação primária consultada via Context7, biblioteca `/microsoft/playwright`:

- https://github.com/microsoft/playwright/blob/main/docs/src/api/class-locator.md — actionability e resolução de locators.
- https://github.com/microsoft/playwright/blob/main/docs/src/api/class-page.md — esperas por tempo fixo desencorajadas.

Essas fontes sustentam manter ações por locator e esperas orientadas a estado. Não demonstram preço, desempenho do deployment ou funcionamento interno de produtos concorrentes.
