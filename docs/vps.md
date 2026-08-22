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
