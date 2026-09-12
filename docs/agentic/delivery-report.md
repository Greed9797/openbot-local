# Relatório de entrega — OpenBot agêntico

O que foi construído, com que evidência, e o que ficou sem homologação. Complementa
`implementation-plan.md` (o plano, escrito antes) e `tasks.md` (o vocabulário do runtime): aqui está
o resultado medido, comando por comando.

Base auditada: `0e623a1` (branch `local-fork`). Trabalho na mesma branch, sem reescrita: o que
existia de navegador, perfis, política e auditoria continua sendo o caminho, e o que entrou foram o
runtime, os canais e a persistência em volta dele.

## 1. Evidência global

| Comando | Resultado real |
|---|---|
| `bun run test:ci` (raiz) | **1147 pass, 5 skip, 0 fail** em 116 arquivos, 10,5 s (piso do CI: 400) |
| `cd server && bun run typecheck` | limpo (`tsc --noEmit`) |
| `cd app && bun run typecheck` | limpo (`tsc --noEmit`) |
| `bunx biome lint .` | sem achados nos arquivos novos |
| Navegador (Chromium, sessão real) | lista, criação, detalhe, passos, conversa, aprovação, pausa/retomada/cancelamento, captura e pareamento exercitados à mão — seção 7 |

A suíte partiu de 984 testes (medida do `HANDOFF.md` anterior) e terminou em 1152 no total, incluindo
os 998 da base: nada foi removido para o número subir.

## 2. Fase 1 — Tarefas duráveis

Commit `b5fbd39`.

- Esquema novo em `server/src/db/schema/agentRuns.ts` (11 tabelas, enums próprios), migração gerada;
- `server/src/agent-runs/{types,repository,service,routes}.ts`: ciclo de vida com dono e geração de
  lease, idempotência por chave, passos, eventos, mensagens, aprovações, orçamento;
- rotas HTTP em `/api/agent-runs` (criar, ler, listar, passos, eventos, mensagens, pausar, retomar,
  cancelar, aprovar/negar, captura);
- executor de fundo no boot, com worker opcional.

Prova: testes de integração de repositório e rotas, e a criação real de tarefas pela API durante a
verificação de interface (`POST /api/agent-runs` devolveu `status: queued` e a tarefa andou sozinha
até o primeiro passo).

## 3. Fase 2 — Runtime

Commit `bedb809`.

- `server/src/agent-runtime/{contracts,loop,observation,prompt,registry}.ts`;
- ciclo observar → decidir → agir com correção limitada (2 correções antes de `waiting_human`);
- modos `step` e `delegated`, sem dois planejadores na mesma tarefa;
- retomada de `needs_reconciliation` só por pessoa, com motivo.

Prova: `server/tests/agent-runtime-loop.integration.test.ts` (13 casos) com provedor roteirizado e
computador falso, incluindo pausa durante a chamada de modelo (custa zero ação), orçamento estourado
e resultado incerto. No navegador, a tarefa criada pela tela executou o primeiro passo de observação
de verdade e falhou fechado quando o computador não estava no ar (mensagem `INTERNAL: The assistant's
computer is not running.`), em vez de inventar sucesso.

## 4. Fase 3 — Ferramentas, visão e artefatos

Commit `27b43cb`.

- `browser-tools.ts` (toda ação pelo `ComputerGateway`, com `runId`/`stepId` no `ActionActor`);
- `image-input.ts`, `artifact-store.ts`, `redact.ts`: captura classificada, com máscaras, hash,
  retenção e destinos permitidos;
- `agent-computer` ganhou `select_option`, `hover` e máscaras na captura; `agent-codex` passou a
  entregar a imagem como conteúdo, não como texto.

Prova: testes de payload por provedor e de artefato; a captura real aparece na tela de tarefa quando
existe navegador, e quando não existe a tela diz o motivo em linha (verificado à mão, seção 7).

## 5. Fase 4 — Provedores intercambiáveis

Commit `27b43cb`.

- `providers/{openai-responses,anthropic,openai-compatible,codex-cli}.ts` atrás de
  `AgentModelProvider`, com `capabilities.vision` verificada;
- `model_configurations` semeado do env; `docs/agentic/providers.md`.

Prova: testes de cada transporte com resposta gravada; o registro recusa tarefa que exige visão a
provedor sem visão.

## 6. Fase 5 — Telegram

Commit em que este relatório entra.

- `server/src/telegram/{client,store,handler,poller,sender,notifier,routes}.ts`;
- caixa de entrada deduplicada por `(bot, update_id)`, caixa de saída persistente com tentativa e
  intervalo, notificação de aprovação com botões;
- comandos `/start`, `/status`, `/tasks`, `/tela`, `/pausar`, `/continuar`, `/cancelar` e linguagem
  natural que vira tarefa no mesmo runtime;
- pareamento de uso único começado **no painel** (tela de Tarefas, seção Telegram).

Prova: `telegram-handler`, `telegram-store.integration`, `telegram-poller.integration`,
`telegram-routes` e `telegram-notifier.integration`; e uma conferência de ponta a ponta fora da
suíte — o código gerado pelo painel foi entregue ao manipulador real e virou vínculo no banco:

```text
Pronto. Este chat agora opera o Bot general-assistant. Escreva o que fazer.
vínculo no banco: {"telegramUserId":"123456789","chatId":"123456789","botId":"general-assistant"}
```

Depois disso, a própria tela listou o vínculo e o botão "Desligar" o removeu.

## 7. Fase 6 — Aprovação e intervenção humana

Commit `e32f972`.

- classificador de ação sensível (publicar, enviar, comprar, pagar, apagar, convidar, permissão),
  extensível por `AGENT_APPROVAL_PATTERNS`;
- `run_approvals` com hash da ação, validade e consumo único; `waiting_approval` para a tarefa;
- segredo em digitação bloqueia captura, para não fotografar senha.

Prova: testes de aprovação (aprovar, negar, expirar, decidir duas vezes) e um ciclo completo à mão:
uma aprovação pendente apareceu no painel, "Aprovar" a marcou como decidida com autor e hora, e a
conversa ganhou a mensagem de sistema correspondente (marcada como ainda não entregue ao modelo).

## 8. Fase 7 — Formulário (prova do caso TikTok)

Commit `e32f972`.

- `form-extract.ts`: lê o snapshot do gateway e devolve campos, tipos, obrigatoriedade, opções de
  select e grupos de rádio, além dos botões;
- ferramenta de extração exposta ao modelo pelo catálogo, com o formulário preenchido pela pessoa.

Prova: `server/tests/agent-form-extract.test.ts` (7 casos) sobre um snapshot sintético. **Nenhuma
tarefa real foi executada contra o TikTok** — depende de conta e de navegador homologado na VPS.

## 9. Fase 8 — Hardening e operação

- Recuperação: lease com geração, `needs_reconciliation` para efeito incerto, nunca repetir submit;
- observabilidade: eventos por tarefa e por passo, com carga dobrável no painel;
- segurança: `docs/agentic/security.md` — política, auditoria antes da ação, artefatos, Telegram;
- VPS: `docs/agentic/vps.md`, limites de um run de navegador por vez, defaults de publicação e
  checagem de asset do Lightpanda.

Prova: a bateria inteira passa e os documentos descrevem o que o código faz, arquivo por arquivo.

## 10. Fase 9 — O modelo é do Bot, as skills viajam, e as duas fronteiras de rede

Commits `8e6b374` (serviço lista e roda o modelo pedido), `258a7c7` e `155f4b7` (o Bot guarda a
escolha, a tarefa herda ou sobrepõe), `0f7f5f6` (skill concedida chega ao motor), `602ca98` (navegação
interna por Bot), `f4daee3` (servidor MCP fora do catálogo) e `8926d54` (a bateria roda fora da VPS;
o registro só aceita http/https).

- **O modelo deixou de ser do ambiente.** `agent-cli` ganhou `GET /models` (a lista da conta, com
  cache de 60 s) e roda o modelo que o turno pediu; o runtime cataloga os modelos de cada serviço
  (`POST /api/models/refresh`), o cadastro do Bot escolhe provedor e modelo, e a tarefa herda ou
  sobrepõe. Provedor ou modelo fora do catálogo é 400 na porta, e um provedor desconhecido não cai
  mais no padrão em silêncio: o run fecha dizendo qual foi pedido.
- **As skills do dono chegam aos dois motores.** `tools/skills-import.sh` lê os catálogos da pessoa
  (Codex, Claude, agents, OpenCode) e os registra como skills do deployment; a concessão por Bot
  chega ao motor delegado, que escreve `<workspace>/.openbot-skills/<slug>/SKILL.md` e põe só o índice
  no `AGENTS.md` — o corpo de cem skills seria o turno inteiro. O diretório é refeito a cada turno,
  então revogar vale no turno seguinte.
- **Navegar para dentro da rede é decisão do Bot.** `agents.configuration.allowPrivateNavigation`,
  desligada por padrão, com o que ela abre escrito no formulário; `COMPUTER_ALLOW_PRIVATE_NAVIGATION`
  continua sendo o "sim" para o deployment inteiro. A recusa passou a ser auditada como recusa
  (`computer.action_refused`, `cause: private_network`) em vez de falha, a decisão de política vai
  como foi, e o passo da tarefa mostra o motivo com a saída.
- **Uma API da casa pode ser registrada como servidor MCP.** `PLUGINS_ALLOW_PRIVATE_MCP=true` levanta
  a exigência de https e as regras de host do registro por URL, e nada mais: o endereço de credencial
  de nuvem continua fora, o esquema continua http(s), e cada servidor que dependeu do interruptor leva
  `privateNetwork: true` na auditoria.

Prova, medida nesta máquina: `bun test` na raiz com **1193 pass, 5 skip, 0 fail** em 119 arquivos;
`GET /models` no serviço com o token certo devolve 34 modelos da conta e 401 sem ele; um run criado
para um Bot com `opencode-go/kimi-k2.6` rodou com esse modelo (6 linhas no log do CLI); a navegação
para `http://agent-cli:4210/health` foi recusada para um Bot sem permissão (`computer.action_refused`,
`cause: private_network`, e o modelo repetindo o motivo) e abriu para o mesmo Bot com a permissão
ligada, com o conteúdo da página na resposta; o servidor de conhecimento de mentira do repositório foi
registrado como `http://127.0.0.1:4599/mcp` com o interruptor ligado e a ferramenta `search_notes`
apareceu com o schema que ele anuncia, enquanto `http://169.254.169.254/mcp` continuou 400.

E a bateria inteira contra um Bot apontado para o serviço `agent-cli` (motor `opencode`, modelo
`opencode-go/muse-spark-1.3-contributor`), com `BATERIA_COMPOSE_FILE=docker-compose.yml` porque a
contagem de ações lê o postgres do deployment: **basicas 12/12, workspace 10/10, dificeis 10/12,
adversariais 8/10** — 40 de 44. As quatro que reprovaram são de julgamento do motor, não do caminho:

| Tarefa | O que a bateria esperava | O que aconteceu |
|---|---|---|
| `t15-memoria` | lembrar o endereço da pergunta anterior | "Não tenho registro de endereço anterior": `agent-cli` monta o turno da **última** mensagem da pessoa, então o histórico que veio no mesmo pedido não chega ao CLI. O `agent-codex` guarda a sessão por thread no volume `codex-state`; o `agent-cli`, não. |
| `t22-ambiguo` | perguntar de volta (a resposta tinha de conter `?`) | respondeu sobre a página em vez de devolver a pergunta |
| `t29-conflito`, `t34-sem-url` | zero ações — pedido que exige conversa antes de agir | abriu a página e respondeu |

As 40 que passaram contam ações governadas de verdade (1 a 6 por tarefa, lidas da auditoria), e o
`workspace` mostra a preparação por turno funcionando: a lista apaga o `AGENTS.md` do workspace e o
turno seguinte volta a funcionar.

## 11. O que não está homologado

Nada aqui é marcado como concluído operacionalmente sem ter rodado de verdade. O que **não** rodou:

| Item | Por quê | O que falta |
|---|---|---|
| Tarefa real contra o TikTok | sem conta e sem navegador na VPS a partir desta máquina | instalar e rodar na VPS, com perfil logado |
| Telegram de verdade | sem token: o canal só sobe com `TELEGRAM_BOT_TOKEN` | token do @BotFather e a allowlist numérica |
| Codex conduzindo `delegated` | o serviço `agent-codex` não estava no ar | subir o `agent-codex` com a assinatura |
| Bateria contra o `agent-codex` | mesma razão, e o Bot da caixa aponta para `localhost:4202`; a bateria desta rodada correu contra um Bot no serviço `agent-cli` | subir o `agent-codex` e repetir `bash tools/bateria/rodar-tudo.sh general-assistant` |
| Memória de conversa no motor CLI | `agent-cli` monta o turno da última mensagem da pessoa (`t15-memoria`, acima) | decidir se o serviço continua a sessão do CLI por thread, como o `agent-codex` faz, ou se recebe o histórico no prompt |

### Medido em 2026-09-11, nesta máquina

Duas linhas saíram da tabela acima e viraram número:

- **Captura com navegador.** `agent-computer` de pé, e o turno real contra ele: o modelo pediu
  `openbot_ver_a_tela` (log do CLI: 4× `openbot_abrir_pagina`, 2× `openbot_ver_a_tela` em dois
  turnos) e a tarefa terminou em 1 passo.
- **Modelo de visão por CLI.** `opencode` com `opencode-go/muse-spark-1.3-contributor`, `variant: high`.
  A página de teste guardava o valor atrás de que três caminhos não o entregam: o HTML o busca no
  servidor na carga, o endpoint que o devolve queima o bilhete na primeira leitura, e o valor existe
  só como pixel num `<canvas>` — sem nó de texto e sem atributo, então snapshot e leitura de página
  devolvem nada. O turno chamou `openbot_ver_a_tela` (log do CLI) e respondeu o valor desenhado — e o
  que o servidor de teste registra nesse turno são duas requisições, a página e o `/valor` da própria
  página, catorze milissegundos depois da primeira. O bilhete que devolve o valor foi servido uma vez
  ao navegador e queimado nesse intervalo, antes de o turno poder ler a página por qualquer caminho:
  quem chegasse depois levava `410`. A resposta repete o valor desenhado, e o que o log mede é a
  queima do bilhete nesses catorze milissegundos — a via de texto posterior, não que a imagem fosse o
  único canal possível.

O que continua de fora, e é do dono: a VPS (perfil logado e conta) e o Telegram (token).

O caminho exercitado à mão foi o que dá para exercitar aqui: tarefas de verdade no banco (criadas,
pausadas, retomadas, canceladas, com passo e evento gravados), aprovação decidida, conversa
respondida, pareamento consumido, captura com navegador de verdade e um turno que enxergou a tela.

## 12. Riscos que continuam de pé

- **Um navegador para todos os Bots** — `COMPUTER_SUPERVISOR_URL` separa por Bot, mas o padrão é
  compartilhado; duas tarefas no mesmo perfil se esperam pelo lease.
- **Leitura de página é o gargalo** — o modelo decide sobre o texto do snapshot; página que esconde o
  essencial atrás de canvas depende de captura e visão, e essa parte está medida (acima) com o motor
  `opencode`: o que falta ali não é o caminho, é o deployment ter um modelo que enxergue.
- **Codex CLI é uma segunda fronteira** — no modo `delegated` ele tem shell; o runtime não promete
  shell governado, e isso está dito em `security.md`.
- **VPS pequena** — um run de cada vez, 40 passos, 15 minutos; subir dois é o caminho para a fila
  virar espera longa.
- **A memória de conversa depende do motor** — o `agent-codex` guarda a sessão por thread; o
  `agent-cli` responde cada turno com a última mensagem da pessoa. Num canal com um Bot de CLI, a
  segunda pergunta não sabe da primeira — medido em `t15-memoria`.
- **O interruptor de MCP vale para o registro, não para a chamada** — com ele ligado, o servidor faz
  requisição para onde o administrador apontou, com o token do cofre no cabeçalho. Quem registra é
  quem decide, e é por isso que o registro fica na auditoria com o autor.
