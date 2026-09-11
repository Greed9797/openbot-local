# Provedores de modelo

Os adaptadores em `server/src/agent-runtime/providers/`, o que cada um manda de diferente,
`capabilities`, análise de captura e escolha do padrão. Implementado sem homologação:
nenhum modelo pago foi chamado de verdade, o teste de canvas (AT-01) não rodou e o
`testedAt` segue nulo.

## Os adaptadores

| Id (`AgentModelConfig.id`) | Transporte | Arquivo | Endpoint |
|---|---|---|---|
| `openai-responses` | `responses` | `openai-responses.ts` | `POST {base}/responses` (`https://api.openai.com/v1` por padrão) |
| `anthropic` | `messages` | `anthropic.ts` | `POST {base}/messages` (`https://api.anthropic.com/v1`) |
| `gemini` | `gemini` | `gemini.ts` | `POST {base}/models/{model}:generateContent` (`https://generativelanguage.googleapis.com/v1beta`), com `x-goog-api-key` |
| `local` | `chat-completions` | `openai-compatible.ts` | `POST {base}/chat/completions` (`AGENT_LOCAL_BASE_URL`, ex. Ollama/vLLM/llama.cpp) |
| `codex` | `delegated` | `codex-delegated.ts` | AG-UI via `HttpAgent` (`AGENT_CODEX_URL` ou `MANAGED_AGENT_AG_UI_URL`) |
| `opencode`, `mimo` | `delegated` | `codex-delegated.ts` | AG-UI (`AGENT_OPENCODE_URL`, `AGENT_MIMO_URL`) — serviço `agent-cli`, um processo por CLI; ver `docs/vps.md` |

Um CLI de agente é do mesmo adaptador delegado do Codex: do lado do runtime muda o endereço e o id,
não o código. Quem escolhe o binário, o modelo e a conta é o serviço do outro lado (`AGENT_CLI`),
e o `agentId` do AG-UI é o id do provedor — o mesmo que o catálogo mostra.

Todos recebem o mesmo `AgentRunInput` (objetivo, observação, histórico de 20 passos,
mensagens pendentes, ferramentas, orçamento, uso) e devolvem `AgentRunResult`
(`tool_call` | `final` | `help` | `invalid` | `delegated`). Sem estado no provedor:
`store: false` no Responses; cada passo é um pedido completo, o fio está na tabela de
passos. Timeout padrão de 300 s (`timeoutMs ?? 300_000`).

## O que cada um recebe de diferente

Imagem: só viaja quando `capabilities.vision` é verdadeiro — e o loop só pede captura
(`wantImage`) quando o provedor tem visão. O `data` base64 existe só no caminho até o
adaptador; nunca é persistido (`contracts.ts`, `ObservationImage`).

| Adaptador | Bloco de imagem | Ferramentas no pedido | Leitura da resposta |
|---|---|---|---|
| Responses | `{ type: "input_image", image_url: "data:<mime>;base64,…", detail: "high" }` em `content` de uma única mensagem `user` (`input: [userMessage]`) | `{ type: "function", name, description, parameters, strict: false }` + `tool_choice: "auto"`; ausentes sem `tools` | Itens de `output`: primeira chamada de função ou texto (`readResponse`, `toCall`) |
| Anthropic | `{ type: "image", source: { type: "base64", media_type, data } }` ao lado de `{ type: "text" }` | `{ name, description, input_schema }`; sistema vai em `system` separado, não em mensagem | Blocos de `content`: `tool_use` decide o passo; sem ele, o texto vira `final`. `max_tokens` padrão 4 096 |
| chat-completions | `{ type: "image_url", image_url: { url: "data:<mime>;base64,…" } }` | Nativas (`{ type: "function", function: { name, description, parameters } }`) quando `AGENT_LOCAL_TOOLS=on`; senão o catálogo vai em texto (`toolsAsText`) e a resposta é lida por `decisionFromText` (`{tool, arguments, final, help}` + `evidence`) | `tool_calls` na mensagem, ou texto via `readTextResponse` |
| Gemini | `{ inlineData: { mimeType, data } }` ao lado de `{ text }` em `parts` | `functionDeclarations` dentro de `tools`; a chamada volta em `parts[].functionCall` | `candidates[0].content.parts`: `functionCall` decide o passo; sem ele, o texto vira `final`. `finishReason` de bloqueio vira erro dito, não resposta vazia |
| Delegado (Codex, OpenCode, MiMo) | Nenhuma: `delegatedObjective` manda só objetivo + `historyBlock` (a observação deste processo seria "fotografia de outro momento") | Nenhuma: o CLI conduz o próprio ciclo com as ferramentas MCP | Resultado `delegated` com mensagem, `toolCalls` e evidência; o `CUSTOM` `openbot.tools` do serviço é o que faz o run saber que o navegador foi usado |

Cabeçalhos: Responses e chat-completions usam `authorization: Bearer <apiKey>`
(chat-completions omite quando não há chave — servidor local sem auth);
Anthropic usa `x-api-key` + `anthropic-version: 2023-06-01`; Gemini usa `x-goog-api-key`;
o delegado manda `x-openbot-agent-token` quando o deployment tem `MANAGED_AGENT_TOKEN`.
Sem credencial configurada o adaptador nem é criado (`createProviderFor` devolve
`undefined`) e a tarefa falha com `PROVIDER_UNAVAILABLE` em vez de fingir execução.

## `capabilities`

`ModelCapabilities = { vision, tools, streaming, mode }` (`contracts.ts`):

- `vision`: do ambiente nos adaptadores de API (presunção pelo nome do modelo, ver o fim) e do
  `AGENT_CODEX_VISION` / `AGENT_OPENCODE_VISION` / `AGENT_MIMO_VISION` no delegado — que é o único
  que sabe qual modelo roda lá dentro. **O adaptador delegado recebe essa decisão, não a presume**:
  com visão presumida, todo passo pediria captura a um modelo de texto e a análise de tela escolheria
  justamente ele (`analyze-image.ts` pega o primeiro provedor que diz enxergar).
- `tools`: do ambiente nos adaptadores de API. No delegado é sempre `false`: o runtime não entrega
  catálogo de ferramentas a quem conduz o próprio ciclo.
- `streaming`: sempre `false` em `createProviderFor` — o `onDelta` do `AgentRunContext` existe no
  contrato, sem produtor. O delegado declara `true` porque o transporte AG-UI responde em fluxo.
- `mode`: `"step"` para os adaptadores de API (o runtime conduz observar→decidir→agir e chama `run`
  uma vez por passo); `"delegated"` quando `transport === "delegated"` (`run` uma vez por tarefa).
- `AGENT_LOCAL_TOOLS=on` (padrão) existe para declarar sem ferramentas um modelo local que
  não as tem, sem descobrir na primeira chamada.

## `instructions` e análise de captura

`AgentRunInput.instructions` substitui o papel padrão do sistema para a pergunta que não é
um passo de tarefa. Único uso: `analyze-image.ts` — `INSTRUCTIONS` pede JSON puro
`{"final":"…"}` descrevendo a tela sem inventar. `analyzeImage` monta uma observação
sintética (só a imagem, `tools: []`, orçamento de 1 passo) e devolve o texto do `final`.
`visionProvider` escolhe o primeiro provedor da lista do registro com `vision: true` —
ou seja, a análise pode usar um modelo diferente do da tarefa. Sem nenhum com visão,
`NoVisionModelError` ("Nenhum modelo configurado neste deployment vê imagens…").

## Como o provedor padrão é escolhido

1. `agentModels(env)` (`config.ts`) constrói a lista na ordem: `openai-responses`
   (se `AGENT_OPENAI_API_KEY` ou `OPENAI_API_KEY`), `anthropic` (idem), `gemini`
   (`AGENT_GEMINI_API_KEY`, `GEMINI_API_KEY` ou `GOOGLE_API_KEY`), `local` (se
   `AGENT_LOCAL_BASE_URL`), e os delegados — `codex` (se `AGENT_CODEX_URL` ou
   `MANAGED_AGENT_AG_UI_URL`), `opencode` (`AGENT_OPENCODE_URL`), `mimo` (`AGENT_MIMO_URL`).
2. `AGENT_DEFAULT_PROVIDER` ou `providers[0]?.id` ou `"codex"`; `AGENT_DEFAULT_MODEL`
   ou o modelo desse provedor. `AGENT_DEFAULT_PROVIDER` apontando para id não configurado
   recusa o boot com erro explícito.
3. Sem credencial nenhuma: zero provedores, aviso no boot, tarefas falham com
   `PROVIDER_UNAVAILABLE`.
4. Em execução: `providers.get(run.provider) ?? providers.default()` (`loop.ts`).

O que este deployment tem, para quem precisa conferir depois de subir um serviço novo, é
`GET /api/models` (`model-catalog.ts` + rota em `app.ts`, atrás de sessão): o id de cada provedor,
o modelo declarado, transporte e `capabilities` — a interseção entre o que o `.env` declarou e o que
o registro construiu, sem credencial e sem endereço no corpo. Um `AGENT_OPENCODE_URL` que não chegou
ao runtime aparece aqui como ausência, que é o que o deploy precisa ver.

Visão é presumida pelo nome (`visionFor`: `gpt-5|gpt-4o|gpt-4.1|o3|o4|claude|gemini|
llava|qwen.*vl|pixtral|internvl`), negável por id em `AGENT_TEXT_ONLY_PROVIDERS` e
forçável em `AGENT_VISION_PROVIDERS`. A presunção é registrada, não homologada:
`model_configurations` (`model-configurations.ts`, `sync` a partir do env, sem apagar
`testedAt`) guarda `capabilities`/`limits`, e `markTested` só é chamado por quem roda a
verificação manual — nenhum caminho automático o faz.

## Não homologado

- Chamadas reais a OpenAI/Anthropic/Gemini pagas; o caminho foi exercitado com `fetchImpl`
  injetável e fixtures, não contra as APIs.
- Leitura de imagem por modelo local (`llava`, `qwen*vl` etc. via `local`): presunção por
  regex, sem teste de canvas.
- Codex delegado: exige o serviço AG-UI de pé (`AGENT_CODEX_URL`); comportamento do
  `codex exec` real só se comprova no ambiente alvo.
- MiMo Code: o adaptador é provado no fio (argv, config, eventos), sem o CLI instalado aqui.
  O OpenCode, que é o mesmo tronco, foi medido de ponta a ponta — CLI local dirigindo o
  navegador da VPS pelo gateway, com a linha `computer.action_allowed` nomeando o Bot e a
  pessoa da declaração assinada.
