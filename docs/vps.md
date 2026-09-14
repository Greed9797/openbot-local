# Running this on your own VPS, 24/7

This fork removes the two things that made the upstream project somebody else's: the CopilotKit
Intelligence account it refused to boot without, and the model API key it needed to answer anything.
What is left runs on one machine you rent, with the Codex CLI's ChatGPT subscription as the model.

## What actually leaves the machine

| Destination | Before | Now |
| --- | --- | --- |
| `api.intelligence.copilotkit.ai` | every thread and message | nothing. `RUNTIME_MODE=local` |
| `api.cloud.copilotkit.ai` | product telemetry | nothing. `COPILOTKIT_TELEMETRY_DISABLED=true`, `DO_NOT_TRACK=1` |
| CopilotKit licence check | required to boot | not called. The SSE runtime has no licence gate |
| OpenAI API | every Bot turn, billed per token | not used by the Codex Bot |
| ChatGPT / Codex backend | — | the turns themselves, over your subscription |

The last row is the honest limit: the model is not on your machine. Codex sends the conversation to
OpenAI the same way it does when you type in a terminal. What changed is that CopilotKit is no longer
a third party to it, and there is no per-token bill.

Verify rather than trust. With the server up:

```sh
curl -s localhost:3001/api/copilotkit/info | jq '{mode, telemetryDisabled}'
# {"mode": "sse", "telemetryDisabled": true}
```

`"mode": "sse"` is the server saying it holds no Intelligence client. For proof at the network level
rather than the configuration level, block egress to `*.copilotkit.ai` on the host and confirm
nothing breaks.

## Sizing

From `docs/deployment.md`, plus the Codex Bot:

- **4 GB RAM.** 2 GB is the floor for one person; each concurrent Bot browser adds about 1 GB, and
  `agent-codex` adds a Node process per in-flight turn.
- **2 vCPU.**
- **20 GB disk.** The app image is 5.3 GB (the Playwright base carries Firefox and WebKit), the
  Codex image adds Node and the CLI, and `/workspace` needs room for whatever the Bot is working on.
- **One replica.** Browser snapshots live in process memory, so a second replica answers a click with
  a snapshot it never took.
- **TLS in front.** A page served over plain `http://` on anything but localhost is not a secure
  context, and the sign-in cookie wants `Secure`.

## Bring it up

```sh
git clone <your fork> openbot && cd openbot
cp .env.example .env
```

Then, in `.env`:

1. `KEY_ENCRYPTION_KEY`, `MANAGED_AGENT_TOKEN`, `COMPUTER_TOKEN`, `SUPERVISOR_TOKEN`, `AGENT_TOOL_TOKEN`
   — one `openssl rand -base64 32` each. The `KEY_ENCRYPTION_KEY` in the example is public.
2. `POSTGRES_PORT=127.0.0.1:55432` and the matching `DATABASE_URL`. The mapping in the compose file
   is `"${POSTGRES_PORT}:5432"`, so naming an interface here is what keeps the database off the open
   internet — the bare default publishes it on every one.
3. Leave `RUNTIME_MODE=local`.

```sh
docker compose up -d postgres agent-codex openbot
```

Three services, not the whole file. `openbot` is the one image the root Dockerfile builds: the app,
the API and the browser the Bots drive. `agent-bot`, `agent-langgraph`, `agent-computer`, the
supervisor and SPIRE are alternatives to what that image already contains, and starting them as well
is how you end up with two of everything.

Expect the `openbot` image to take a while and land at about 7 GB; most of it is the Playwright base.

## Reaching it

Nothing is published on a public interface — `docker compose ps` should show every port bound to
`127.0.0.1`. Reach it over an SSH tunnel:

```sh
ssh -N -L 3011:127.0.0.1:3001 root@your-vps
# then open http://127.0.0.1:3011
```

To serve it on a hostname instead, put a reverse proxy on the host that terminates TLS in front of
`127.0.0.1:3001`, and configure an identity provider first — see below.

## Sign Codex in

The Bot has no API key. It authenticates from `CODEX_HOME` inside the `agent-codex` container, which
is the `codex-state` volume, and it is put there once:

```sh
# from a machine that is already signed in
scp ~/.codex/auth.json root@your-vps:/tmp/codex-auth.json
ssh root@your-vps
cd /opt/openbot-local
docker compose cp /tmp/codex-auth.json agent-codex:/state/codex-home/auth.json
docker compose exec -u root agent-codex sh -c 'chown bun:bun /state/codex-home/auth.json && chmod 600 /state/codex-home/auth.json'
shred -u /tmp/codex-auth.json
```

Or, with an access token rather than the file:

```sh
docker compose exec agent-codex sh -c 'printenv CODEX_ACCESS_TOKEN | codex login --with-access-token'
```

That file lets anything holding it act as the ChatGPT account it belongs to. It lives in the
`codex-state` volume, which means every backup of that volume carries it too.

Confirm it took:

```sh
docker compose exec agent-codex codex login status
```

**This is the one moving part of running on a subscription.** The token expires. An API key does not.
A deployment meant to stay up needs either something that refreshes it or somebody who notices when
turns start failing — watch the `agent-codex` logs for a non-zero exit mentioning authentication.

## Um CLI de agente como motor (OpenCode)

O runtime fala com modelos de duas maneiras: ele conduz o ciclo (observe → decida → aja) com um
provedor de API, ou entrega a tarefa inteira a um serviço que conduz o próprio ciclo. O `agent-cli` é
da segunda família, e o modelo dele É um CLI — o mesmo que você já usa no terminal, com a conta que
você já paga.

Serve para três coisas concretas:

- **Usar um plano já pago** como motor do Bot, sem chave de fornecedor no runtime. O "OpenCode Go",
  por exemplo: quem autentica é o CLI, no formato dele.
- **Usar um modelo gratuito** para as tarefas do dia a dia, e reservar o modelo caro para o que
  precisa dele.
- **Testar o mesmo Bot em motores diferentes** sem mexer no servidor: é uma variável de ambiente.

O que **não** muda: o navegador. O CLI recebe o navegador do Bot por MCP — o mesmo
`shared/mcp-computer.ts` que o Codex usa —, então cada página aberta passa pelo gateway, pela política
de `/admin/boundaries` e vira linha em `/admin/audit`. A busca embutida do CLI (`webfetch`,
`websearch`) fica **negada** pela configuração que o serviço escreve no workspace: a web só entra pelo
caminho auditado.

### Ligar

```sh
cd /opt/openbot-local

# A conta do CLI, em base64 — o mesmo arquivo que o login escreve.
#   OpenCode:  base64 -i ~/.local/share/opencode/auth.json | tr -d '\n'
printf 'AGENT_CLI=opencode\nAGENT_CLI_MODEL=opencode-go/deepseek-v4.1-flash\nAGENT_CLI_AUTH_JSON=%s\n' "$(base64 -i ~/.local/share/opencode/auth.json | tr -d '\n')" >> .env
printf 'AGENT_OPENCODE_URL=http://agent-cli:4210/ag-ui\nAGENT_OPENCODE_MODEL=opencode-go/deepseek-v4.1-flash\n' >> .env

bash tools/deploy.sh
```

Qual modelo a conta tem é pergunta para o CLI, não para este deployment:

```sh
docker compose exec agent-cli opencode models      # provider/model, um por linha
```

`AGENT_CLI_MODEL` (o que o CLI roda) e `AGENT_OPENCODE_MODEL` (o que o runtime registra) são o mesmo
nome visto dos dois lados: o runtime não escolhe, ele só diz qual é no catálogo e no passo da tarefa.
O **degrau de raciocínio** é `AGENT_CLI_VARIANT` (`high`, `max`, `minimal` — o vocabulário é do
fornecedor, e o serviço apenas repassa). Ele muda custo e latência de cada passo, e numa tarefa de
navegador cada passo é uma chamada de modelo: vale escolher com o número na mão, não no escuro.

A `AGENT_OPENCODE_URL` é o que faz o runtime enxergar o serviço como modelo; sem ela o container
sobe e ninguém o usa. Confira os dois lados:

```sh
docker compose exec agent-cli opencode --version
curl -s localhost:4210/health         # {"status":"ok","cli":"opencode","model":"…","variant":"high","ferramentas":true}
curl -s "localhost:3001/api/models"   # {"default":"opencode","models":[{"id":"opencode", …}]}
```

`ferramentas: true` é a metade que importa: um CLI sem o MCP responde bem, de memória, e é a mesma
assinatura de todo defeito caro deste fork. `/api/models` é a outra: uma variável que não chegou ao
runtime — nome errado, `AGENT_OPENCODE_URL` ausente — não vira linha nenhuma na lista, em vez de
esperar a primeira tarefa para se manifestar. A rota pede sessão, como as de tarefa: num deployment
single-user o `curl` acima já responde; num com login, vale o cookie da sessão.

O que a lista **não** pega é endereço que existe e aponta para o serviço errado: esse provedor aparece,
porque foi construído, e falha na primeira tarefa. Para esse, o `/health` do serviço acima é a
conferência.

### Gemini, e outros provedores de API

Um provedor de API continua sendo o caminho para um modelo com visão e sem CLI no meio. O Gemini é
nativo (imagem como bytes, ferramenta como `functionCall`):

```sh
printf 'GEMINI_API_KEY=%s\nAGENT_GEMINI_MODEL=gemini-3.8-flash\n' "$SUA_CHAVE" >> .env
```

Nada de rebuild: a lista de modelos é lida do ambiente no boot.

## As suas skills, dentro do Bot

O Bot dirige o navegador com dois motores, e cada CLI lê as skills do próprio diretório. O
`tools/skills.sh` leva um diretório de skills até os dois, sem passar pelo repositório: skill é dado
de quem opera, não código do fork, e um push não deveria publicar as suas.

Do seu computador, onde as skills estão:

```sh
tar -h -C ~/.codex/skills --exclude=.system --exclude=.DS_Store -cf - . \\
  | ssh root@your-vps 'rm -rf /opt/openbot-local/skills && mkdir -p /opt/openbot-local/skills && tar -C /opt/openbot-local/skills -xf -'
```

O `-h` não é opcional: skill que é link simbólico (para `~/.claude/skills`, por exemplo) chegaria
como link quebrado, e um link quebrado tem o pior sintoma possível — o motor lista a skill e o
modelo não encontra o `SKILL.md`.

Na VPS:

```sh
cd /opt/openbot-local
bash tools/skills.sh          # lê ./skills e instala nos dois motores
bash tools/skills.sh --limpar # tira o que ele instalou
```

Ele diz quantas skills chegaram em cada motor e falha se o número não fechar. Onde cada um lê:

| Motor | Caminho no container | Volume |
|---|---|---|
| Codex | `/state/codex-home/skills/<nome>/SKILL.md` | `codex-state` |
| OpenCode | `/state/home/.config/opencode/skills/<nome>/SKILL.md` | `agent-cli-state` |

Uma conversa nova já enxerga as skills; a que está aberta, não — a lista entra no começo do turno.

O `.system` fica de fora, e não é esquecimento: é o catálogo que a conta do ChatGPT sincroniza
sozinha, e o serviço do Codex apaga ele a cada boot. Medido em bateria, o Bot gastou turno abrindo
o `SKILL.md` de um plugin antes de responder sobre uma página — a pasta da conta é ruído para quem
dirige navegador, e as suas skills são o oposto disso.

## Staying up

Every long-lived service carries `restart: unless-stopped`, so they come back after a crash and after
the host reboots. The one-shot `migrate` and `spire-init` deliberately do not. Point an uptime check
at `/health`.

Back up two things:

- **The PostgreSQL volume.** Conversations, coworkers, policy, credentials and the audit trail.
- **The `codex-state` volume.** The Bot's sign-in and its thread-to-session map. Losing it means
  signing Codex in again and every conversation starting over from Codex's side, even though the
  transcript in PostgreSQL survives.

## O motor sem pixels

O Lightpanda roda ao lado do Chromium, não no lugar dele. Serve a ação `fetch`: ler uma página e
devolver o texto, por uma fração da memória. Tudo que a pessoa assiste continua sendo Chromium.

Por que ele não pode ser o único navegador, medido contra o binário e não lido no README:

| Método CDP | Resultado |
| --- | --- |
| `Page.navigate`, `Runtime.evaluate`, `DOM.getDocument`, `Input.*` | funcionam |
| `Accessibility.getFullAXTree` | funciona |
| `Page.captureScreenshot` | responde com sucesso e devolve um PNG de aviso, não a página |
| `Page.startScreencast` | `UnknownMethod` |
| `connectOverCDP` do Playwright | não completa o aperto de mão |

Duas armadilhas que só aparecem no compose. O CDP valida o `Host` que recebe, como o Chrome faz
contra DNS rebinding: com bind em curinga o único aceito é `127.0.0.1:9222`, e chamar pelo nome do
serviço volta "Expected 101 status code". E a telemetria dele vem ligada de fábrica —
`LIGHTPANDA_DISABLE_TELEMETRY=true` está no compose pela mesma razão que a do CopilotKit.

## Conectar o Google Drive

Duas formas, e a escolha não é de gosto — é de tipo de conta.

**Conta pessoal (@gmail.com): OAuth, e só.** Conta de serviço com delegação em todo o domínio
pressupõe um domínio; numa conta pessoal não existe Admin Console onde autorizar o client id. O
Google aceita a chave, devolve um token válido *para a própria conta de serviço*, e a sincronização
termina com sucesso e zero arquivos. É a falha mais cara deste conector porque nada nela parece
falha.

No Google Cloud, uma vez:

1. Crie um projeto e ative a **Google Drive API**.
2. Em *APIs e serviços → Tela de permissão OAuth*, publique o app (ou adicione a própria conta em
   *Usuários de teste* — em modo Teste o refresh token expira em 7 dias).
3. Em *Credenciais → Criar credenciais → ID do cliente OAuth*, tipo **Aplicativo da Web**.
4. Em *URIs de redirecionamento autorizados*, cole exatamente o endereço que a tela
   `/admin/connectors/google-drive` mostra. Ele depende da porta do seu túnel — com
   `ssh -N -L 3011:127.0.0.1:3001` é
   `http://localhost:3011/api/admin/connectors/google-drive/oauth/callback`. O Google abre exceção
   ao HTTPS obrigatório para `localhost` e `127.0.0.1`, mas não trata os dois como sinônimos: use o
   mesmo nome pelo qual você abre a página.
5. Cole client id e secret na tela e clique em **Conectar com o Google**.

Trocar a porta do túnel invalida o URI registrado (`redirect_uri_mismatch`). Registre as duas se for
alternar.

**Workspace com domínio próprio:** conta de serviço continua sendo melhor — concede as pastas uma
vez, no Admin, e não morre quando quem clicou sair da empresa.

Depois de conectar, o botão **Sincronizar agora** devolve a contagem de documentos. Essa contagem é
a única resposta honesta a "funcionou?" — a tela dizer "conectado" não é. Pastas em branco significam
o Drive inteiro; nomear pastas lê os arquivos diretamente dentro delas, sem descer nas subpastas.

Armadilhas medidas aqui:

- Sem `prompt=consent` o Google só emite refresh token na **primeira** concessão. Reconectar uma
  conta que já autorizou o app volta com um access token de uma hora e nada mais, e a sincronização
  para no dia seguinte. Se acontecer, remova o acesso em `myaccount.google.com/permissions`.
- A conexão só é gravada depois que o Google confirma de quem é a conta. Antes disto, `/setup`
  aceitava qualquer objeto JSON e a tela dizia "Configured" sem nunca ter falado com o Google.
- As pastas do `knowledge.yaml` (`Policies`, `Compliance`) são do pacote de exemplo e não existem no
  Drive de ninguém. Herdá-las na conexão produzia a sincronização de sucesso com zero documentos.

## What the Codex Bot can and cannot do

It runs `codex exec` in `/workspace` with `--sandbox workspace-write` and network access. Inside that
directory it can read, write and run commands. `CODEX_SANDBOX=read-only` makes it a Bot that only
answers questions. `danger-full-access` is refused by the service itself — a process taking
instructions from a chat box does not get the whole machine.

**O navegador dele passa pelo gateway.** As ferramentas de computador chegam ao Codex como um servidor
MCP (`agent-codex/src/mcp-computer.ts`) que chama as mesmas rotas `/api/computers/:botId/*` que a
página chama: cada navegação, clique e digitada é julgada pela política e vira linha em
`/admin/audit`. Era o buraco que a versão anterior deste documento registrava como aberto.

**O shell dele não passa.** O que o Codex roda em `/workspace` é governado pelas flags de sandbox e
registrado pelo Codex, não pelo gateway. Duas fronteiras, não uma.

Quatro coisas que essa ponte exigiu, e que falham de formas ilegíveis:

- O Codex **não repassa o próprio ambiente** ao servidor MCP. Sem `mcp_servers.openbot.env.*`, o
  servidor sai no boot e o modelo responde que a ferramenta não está instalada. Só apareceu com
  `RUST_LOG` ligado.
- Chamada MCP **pede aprovação** e `codex exec` roda com política `never`, então toda chamada volta
  recusada. `--approve-for-me` resolve, e **conflita com `--sandbox`** — passar os dois é exit 2.
- `codex exec resume` aceita menos flags que `codex exec`. Nem `--sandbox`, nem `-C`, nem
  `--approve-for-me`. O sintoma é o primeiro turno funcionar e todo segundo falhar.
- Consequência das duas anteriores: **retomar sessão e usar ferramenta são exclusivos**. Aprovar só
  existe no `exec`, e não há equivalente em config — `auto_review.enabled`, `always_allow_tools`,
  `trusted` e `approval_policy="on-failure"` foram medidos e continuam pedindo aprovação. Com MCP
  ligado o Bot sempre abre `exec` novo e o histórico vai no prompt (`HISTORY_TURNS` últimas trocas);
  o que ele fez em `/workspace` continua lá porque aquilo é volume.
- Registrar por `-c` na linha de comando **não funciona**: o Codex aceita a flag e ignora. O caminho
  que grava onde ele lê é `codex mcp add`.

## Subir uma mudança

```bash
bash tools/deploy.sh                      # busca a origin, atualiza, sobe tudo
bash tools/deploy.sh agent-codex          # idem, um serviço
bash tools/deploy.sh --local agent-codex  # reconstrói o commit de pé, sem falar com a origin
```

O sync é do script, não é passo manual antes. Ele busca a origin, avança com `--ff-only`, confere
que o HEAD ficou no commit esperado e só então constrói; no fim, o resultado nomeia o que subiu
(`SMOKE PASSOU no <hash> <assunto>.`). Existe porque duas vezes um `git pull` feito à mão falhou sem
ninguém ver — uma por branch errada, outra por arquivo não rastreado no caminho — e este script
reconstruiu o código velho, o smoke passou (ele prova capacidade, não versão) e o erro só apareceu
comparando hash à mão. Recusa antes de construir qualquer coisa: fetch falho (sem `--local`), branch
sem upstream, mudança rastreada não commitada — o build empacota a árvore como ela está, então isso
não seria commit nenhum — e avanço que não seja rápido.

Depois do sync: build, sobe, espera ficar saudável e roda `tools/smoke-deployment.sh`. Sai diferente
de zero se o smoke reprovar, porque `docker compose up -d` sair com zero não diz nada sobre
capacidade: um Bot sem ferramentas inicia, atende e conversa. Todo defeito sério deste fork foi
descoberto horas depois do deploy que o introduziu, por alguém olhando uma resposta estranha.

O smoke pergunta cinco coisas em menos de um minuto: as ferramentas subiram, as instruções estão no
lugar, o guarda de destino recusa a rede de dentro, uma página pública ainda abre, e o Bot usa o
navegador quando pedem uma página — esta última contra `httpbin.org/uuid`, que muda a cada leitura,
então uma resposta certa não pode ter vindo de memória.

## Quando o Bot responde sem usar o navegador

```bash
bash tools/diagnosticar.sh
```

Junta num lugar os seis sinais que respondem essa pergunta, na ordem de probabilidade e não na de
elegância. Custou horas descobrir essa ordem: já procurei em cache, plugins da conta, orçamento de
contexto e assinatura de execução antes de olhar se o arquivo de instruções ainda existia — que era
a causa.

## O que roda sozinho

A degradação deste Bot é silenciosa: ele continua respondendo. O defeito mais caro daqui — apagar as
próprias instruções mexendo no `/workspace` e voltar a responder de memória — ficou horas assim, e só
apareceu porque alguém resolveu rodar a bateria. Um sistema cujo modo de falha é "continua
respondendo" não pode depender de desconfiança humana.

No `crontab` da VPS:

| Quando | O quê | Onde fica |
|---|---|---|
| Todo minuto 17 | `monitorar.sh smoke` (~1 min) | `logs/smoke.log` |
| 4h40 todo dia | `monitorar.sh bateria` (~25 min) | `logs/bateria.log` |

O log guarda uma linha por corrida quando passa, e a saída inteira quando reprova — um log que guarda
tudo é um log que ninguém abre. Para ver se algo azedou:

```bash
grep REPROVOU /opt/openbot-local/logs/*.log | tail
```

## O Bot usa mesmo as ferramentas?

Esta é a pergunta que a suíte de testes não responde, e foi o defeito mais caro deste fork: o Bot
respondia bem, de memória, sem abrir página nenhuma, e a resposta saía idêntica a uma que tinha sido
lida — com "Fonte:" e link. Pedido três vezes o valor de `httpbin.org/uuid`, que muda a cada leitura,
ele devolveu o mesmo valor inventado nas três.

`tools/bateria/` responde. Roda tarefas do dia a dia e conta as ações no `audit_events`, então quem
afirma ter aberto uma página aparece com zero.

```bash
python3 tools/bateria/bateria.py risk-analyst tools/bateria/tarefas-basicas.json
```

O que fez o Bot passar a usar o navegador, medido de 0/3 para 3/3:

- **`AGENTS.md` no diretório de trabalho**, escrito no boot do `agent-codex`. A mesma regra no prompt
  do turno não muda nada — o Codex a lê como pedido de uma pessoa, e um pedido não muda como ele
  decide. `AGENTS.md` é lido como instrução permanente do projeto.
- **Proibir buscar página pelo shell.** `curl` e `wget` não passam pela política e o que fazem não
  fica no audit.
- **Apagar no boot as skills e plugins que vieram com a conta.** Entrar com uma assinatura do ChatGPT
  sincroniza 47 MB de conectores — Canva, Clay, Drive, HeyGen — e o Bot chegou a gastar turno abrindo
  `/bin/sh` para ler o `SKILL.md` de um deles antes de responder sobre uma página.
- **Perguntar em vez de adivinhar.** Nome de marca não é endereço: perguntado pelo "site da W3bsite",
  ele abriu `w3bsite.com`, caiu numa página de venda de domínios e respondeu com o título dela.

Mesmo assim, quem decide chamar a ferramenta é o modelo. Por isso a rede: quando o pedido cita um
endereço e nenhuma ferramenta foi usada, a resposta termina dizendo que nada foi aberto.

## As tarefas agênticas não têm navegador próprio

As tarefas duráveis (a tarefa "entre no TikTok, preencha o formulário e me avise") rodam no processo
do servidor, com o mesmo `agent-computer` que o chat usa. O que muda no deploy é pouco, e o que muda
importa:

| O quê | Por quê |
|---|---|
| Um worker por fila: `AGENT_WORKER_ENABLED=true` só na réplica que conduz | Dois workers significam duas tentativas da mesma tarefa; o lease protege, mas o desenho é um. O Telegram também sobe só onde o worker roda. |
| `agent-artifacts` é volume nomeado no compose | A captura de cada passo é evidência de auditoria; sem volume, um `--build` apaga o que a retenção prometeu guardar. |
| `AGENT_ARTIFACTS_DIR=/app/.artifacts` dentro do container | O padrão `./.artifacts` cairia no sistema de arquivos efêmero do container. |
| Um navegador ativo por vez | O `browser_profile_leases` serializa: duas tarefas do mesmo Bot não dirigem o mesmo Chromium. Numa VPS de 2 vCPU, é essa conta que governa o paralelismo real. |
| `AGENT_MAX_STEPS`, `AGENT_MAX_RUN_MS` | O teto do que uma tarefa pode consumir sozinha. Padrão: 40 passos, 15 minutos. |
| Migração `0009` | `agent_run_messages` (a conversa com a tarefa) e o enum `run_message_author`. |

O detalhamento — env novas, fluxo, o que conferir depois de subir — está em `docs/agentic/vps.md`. O
que ainda **não** foi homologado em ambiente real: o fluxo de ponta a ponta numa conta TikTok, um bot
de Telegram de verdade e os modelos pagos. Está implementado e testado como unidade; a homologação é
a próxima sessão.

## What was given up with Intelligence

- **Memory.** Cross-thread recall was an Intelligence feature. A busca nos documentos dos conectores
  existe e é outra coisa: full-text do PostgreSQL sobre o que o Google Drive trouxe, alcançada pela
  ferramenta `buscar_conhecimento`.
- **Channels realtime.** The Intelligence WebSocket gateway is what synchronised a channel across
  several people live.
- **Automatic thread names.** Threads keep the id they are given.
- **AG-UI event replay across restarts.** Messages are persisted; the raw event stream behind the
  inspector is not, so a thread that predates the current process shows its conversation but an empty
  event view.

Threads, channels, coworkers, policy, audit and the browser computers are unaffected.

## Keeping up with upstream

`upstream` is CopilotKit's repository and this work sits on the `local-fork` branch. The changes are
deliberately narrow — a mode switch in `config.ts`, a branch in `copilot.ts`, one new runner, one new
Bot — so a merge should conflict only where upstream touches runtime construction. Upstream is alpha
and moves; read `server/src/copilot.ts` after every merge.

### O smoke e um provedor fora do ar

O smoke termina com uma pergunta ao Bot ("abra esta página e diga o que está escrito") e reprova
quando a resposta sai **sem a leitura** — o Bot que fala de memória. Um provedor recusando o turno
(cota da conta esgotada, chave ausente) não é esse defeito: é alto, diz o motivo e não foi causado
pelo deploy. Nesse caso o smoke diz `aviso` com o motivo do provedor e termina em
`SMOKE PASSOU COM AVISOS`. Para exigir o modelo de pé, `SMOKE_EXIGE_MODEL=on`.
