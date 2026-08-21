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

1. `KEY_ENCRYPTION_KEY` — `openssl rand -base64 32`. The one in the example is public.
2. `MANAGED_AGENT_TOKEN` — `openssl rand -base64 32`.
3. **Delete `OPENBOT_SINGLE_USER=true`** and configure Google, Microsoft or Okta. Left in, every
   request that reaches the port is an administrator.
4. `BETTER_AUTH_URL` and `TRUSTED_ORIGINS` — your real hostname, not localhost.
5. Leave `RUNTIME_MODE=local` and `MANAGED_AGENT_AG_UI_URL=http://localhost:4202/ag-ui` alone.

```sh
docker compose up -d
```

## Sign Codex in

The Bot has no API key. It authenticates from `CODEX_HOME` inside the `agent-codex` container, which
is the `codex-state` volume, and it is put there once:

```sh
# on a machine where you can open a browser
codex login
# then, on the VPS, with the access token from that session
docker compose exec agent-codex sh -c 'printenv CODEX_ACCESS_TOKEN | codex login --with-access-token'
```

Or copy an already signed-in `auth.json` into the volume:

```sh
docker compose cp ~/.codex/auth.json agent-codex:/state/codex-home/auth.json
```

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

## What the Codex Bot can and cannot do

It runs `codex exec` in `/workspace` with `--sandbox workspace-write` and network access. Inside that
directory it can read, write and run commands. `CODEX_SANDBOX=read-only` makes it a Bot that only
answers questions. `danger-full-access` is refused by the service itself — a process taking
instructions from a chat box does not get the whole machine.

**Its actions are not in `/admin/audit`.** OpenBot's gateway governs tool calls it executes on a Bot's
behalf; Codex runs its own loop, so its shell commands and file writes are governed by the sandbox and
recorded by Codex. The transcript shows the commands as they run, which is visibility, not a record.

Closing that gap means giving Codex an MCP server that forwards to
`POST /api/agent-tools/call` with the `x-openbot-agent-token` header and the run assertion from
`forwardedProps.openbotRun` — the pattern `agent-langgraph/src/index.ts` already uses. Until then,
the sandbox is the boundary.

## What was given up with Intelligence

- **Memory.** Cross-thread recall was an Intelligence feature.
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
