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
| `local` | `chat-completions` | `openai-compatible.ts` | `POST {base}/chat/completions` (`AGENT_LOCAL_BASE_URL`, ex. Ollama/vLLM/llama.cpp) |
| `codex` | `codex` | `codex-delegated.ts` | AG-UI via `HttpAgent` (`AGENT_CODEX_URL` ou `MANAGED_AGENT_AG_UI_URL`) |

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
| Codex delegado | Nenhuma: `delegatedObjective` manda só objetivo + `historyBlock` (a observação deste processo seria "fotografia de outro momento") | Nenhuma: o Codex conduz o próprio ciclo com as ferramentas MCP | Resultado `delegated` com mensagem, `toolCalls` e evidência |

Cabeçalhos: Responses e chat-completions usam `authorization: Bearer <apiKey>`
(chat-completions omite quando não há chave — servidor local sem auth);
Anthropic usa `x-api-key` + `anthropic-version: 2023-06-01`.
Sem credencial configurada o adaptador nem é criado (`createProviderFor` devolve
`undefined`) e a tarefa falha com `PROVIDER_UNAVAILABLE` em vez de fingir execução.

## `capabilities`

`ModelCapabilities = { vision, tools, streaming, mode }` (`contracts.ts`):

- `vision`/`tools`: do ambiente (ver abaixo). `streaming` é sempre `false` em
  `createProviderFor` — o `onDelta` do `AgentRunContext` existe no contrato, sem produtor.
- `mode`: `"step"` para os três adaptadores de API (o runtime conduz observar→decidir→agir
  e chama `run` uma vez por passo); `"delegated"` para o Codex (`transport === "codex"`,
  `run` uma vez por tarefa).
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
   (se `AGENT_OPENAI_API_KEY` ou `OPENAI_API_KEY`), `anthropic` (idem), `local` (se
   `AGENT_LOCAL_BASE_URL`), `codex` (se `AGENT_CODEX_URL` ou `MANAGED_AGENT_AG_UI_URL`).
2. `AGENT_DEFAULT_PROVIDER` ou `providers[0]?.id` ou `"codex"`; `AGENT_DEFAULT_MODEL`
   ou o modelo desse provedor. `AGENT_DEFAULT_PROVIDER` apontando para id não configurado
   recusa o boot com erro explícito.
3. Sem credencial nenhuma: zero provedores, aviso no boot, tarefas falham com
   `PROVIDER_UNAVAILABLE`.
4. Em execução: `providers.get(run.provider) ?? providers.default()` (`loop.ts`).

Visão é presumida pelo nome (`visionFor`: `gpt-5|gpt-4o|gpt-4.1|o3|o4|claude|gemini|
llava|qwen.*vl|pixtral|internvl`), negável por id em `AGENT_TEXT_ONLY_PROVIDERS` e
forçável em `AGENT_VISION_PROVIDERS`. A presunção é registrada, não homologada:
`model_configurations` (`model-configurations.ts`, `sync` a partir do env, sem apagar
`testedAt`) guarda `capabilities`/`limits`, e `markTested` só é chamado por quem roda a
verificação manual — nenhum caminho automático o faz.

## Não homologado

- Chamadas reais a OpenAI/Anthropic pagas; o caminho foi exercitado com `fetchImpl`
  injetável e fixtures, não contra as APIs.
- Leitura de imagem por modelo local (`llava`, `qwen*vl` etc. via `local`): presunção por
  regex, sem teste de canvas.
- Codex delegado: exige o serviço AG-UI de pé (`AGENT_CODEX_URL`); comportamento do
  `codex exec` real só se comprova no ambiente alvo.
