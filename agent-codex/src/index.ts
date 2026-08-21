import type { BaseEvent, RunAgentInput } from "@ag-ui/core";
import { EventEncoder } from "@ag-ui/encoder";
import { serve } from "bun";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasManagedAgentToken } from "../../shared/agent-authorisation";

/**
 * A Bot whose model is the Codex CLI running on this machine.
 *
 * Every other Bot in this repository reaches a model over HTTP with an API key. This one does not:
 * it runs `codex exec` as a child process, which authenticates with the ChatGPT subscription already
 * signed in on this host. That is the only way a subscription can drive a deployment at all — there
 * is no base URL that accepts it — and it is why this file speaks a subprocess rather than an SDK.
 *
 * What it is NOT: a Bot whose tool calls go through OpenBot's gateway. Codex runs its own loop with
 * its own sandbox, so what it does to files and commands is governed by the sandbox flags below and
 * recorded by Codex, not by `/admin/boundaries` and not in `/admin/audit`. Tools that arrive in
 * `input.tools` are deliberately ignored rather than half-honoured. Routing Codex's work back
 * through the gateway means giving it an MCP server that calls `POST /api/agent-tools/call`; until
 * that exists, this Bot's autonomy is the sandbox's, and that is the honest description of it.
 */

const PORT = Number.parseInt(process.env.PORT ?? "4202", 10);

const MANAGED_AGENT_TOKEN = process.env.MANAGED_AGENT_TOKEN?.trim();
if (!MANAGED_AGENT_TOKEN) {
  console.error(
    "MANAGED_AGENT_TOKEN is not set. This process drives a signed-in Codex session and will not start without a token for OpenBot's server.",
  );
  process.exit(1);
}

const CODEX_BIN = process.env.CODEX_BIN?.trim() || "codex";

/**
 * Where Codex reads its credential and its configuration.
 *
 * Isolated on purpose. Pointed at a person's own `~/.codex` this Bot inherits their `AGENTS.md`,
 * their profiles and every skill they have installed — which is how a "say ok" turn came back as a
 * routing table and an "exceeded skills context budget" error during development. A deployment Bot
 * gets a directory holding its own `auth.json` and nothing else.
 */
const CODEX_HOME = process.env.CODEX_HOME?.trim() || "/state/codex-home";

/** The directory Codex treats as its working root, and the only place it may write. */
const WORKSPACE = process.env.CODEX_WORKSPACE?.trim() || "/workspace";

/** Where the AG-UI thread to Codex session mapping is kept, so a turn can continue the last one. */
const STATE_DIR = process.env.CODEX_STATE_DIR?.trim() || "/state/threads";

const MODEL = process.env.CODEX_MODEL?.trim() || "";
const EFFORT = process.env.CODEX_EFFORT?.trim() || "";

/**
 * How much Codex may do without being asked.
 *
 * `workspace-write` is the working default and the one this is set to. `read-only` is the honest
 * choice for a Bot that should only answer questions. `danger-full-access` is never set here: a
 * process reachable from a chat box must not be able to write outside its workspace.
 */
const SANDBOX = process.env.CODEX_SANDBOX?.trim() || "workspace-write";

if (SANDBOX === "danger-full-access") {
  console.error(
    "CODEX_SANDBOX=danger-full-access is refused. This Bot takes instructions from a chat box; it does not get the whole machine.",
  );
  process.exit(1);
}

/**
 * How long one turn may take before it is abandoned, in milliseconds.
 *
 * Codex working through a real task is slow in a way a chat completion is not, so this is generous.
 * It exists because the alternative to a timeout is a child process that never exits holding a
 * connection nobody is reading any more.
 */
const TURN_TIMEOUT_MS = Number.parseInt(
  process.env.CODEX_TURN_TIMEOUT_MS ?? "900000",
  10,
);

/*
 * The thread map.
 *
 * AG-UI names a conversation; Codex names a session; `codex exec resume <session>` is what makes a
 * second turn continue the first instead of starting over with no memory of the files it just
 * touched. One small file per thread, rather than a database, because this process owns exactly one
 * fact per conversation and a directory on the same volume as the workspace is enough to hold it.
 */
function sessionPath(threadId: string): string {
  // Thread ids arrive from the server, but they still address the filesystem here, so anything that
  // is not plainly a name is replaced rather than trusted.
  return join(STATE_DIR, `${threadId.replace(/[^a-zA-Z0-9_-]/g, "_")}.session`);
}

async function readSession(threadId: string): Promise<string | null> {
  try {
    const value = (await readFile(sessionPath(threadId), "utf8")).trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

async function writeSession(threadId: string, session: string): Promise<void> {
  const target = sessionPath(threadId);
  const temporary = `${target}.${process.pid}.tmp`;
  // Written aside and renamed so a process killed mid-write leaves the previous session id intact
  // rather than a truncated one, which would silently start the next turn from nothing.
  await writeFile(temporary, session, "utf8");
  await rename(temporary, target);
}

/**
 * What to say to Codex this turn.
 *
 * On a resumed session, only the newest user message: Codex is holding the rest itself, and
 * replaying the transcript would both cost the subscription twice and confuse a model that already
 * remembers saying it. On a fresh session the standing role arrives first, because that is the only
 * statement of what this coworker is for.
 */
export function turnPrompt(input: RunAgentInput, resuming: boolean): string {
  const messages = input.messages ?? [];

  const latestUser = [...messages]
    .reverse()
    .find((message) => message.role === "user");
  const userText = String(latestUser?.content ?? "").trim();

  if (resuming) {
    return userText;
  }

  const standing = messages
    .filter(
      (message) => message.role === "system" || message.role === "developer",
    )
    .map((message) => String(message.content ?? "").trim())
    .filter((text) => text.length > 0);

  return [...standing, userText].filter(Boolean).join("\n\n");
}

export function codexArguments(session: string | null): string[] {
  const options = [
    "--json",
    "--skip-git-repo-check",
    /*
     * Without this the sandbox has no network, and a Bot that cannot fetch a page or reach an
     * internal service is not much of a coworker. It is the second of the two settings that decide
     * what this process can actually do; see the sandbox note above for the first.
     */
    "-c",
    "sandbox_workspace_write.network_access=true",
  ];

  if (MODEL) options.push("--model", MODEL);
  if (EFFORT) options.push("-c", `model_reasoning_effort="${EFFORT}"`);

  /*
   * `resume` takes a smaller set of flags than `exec` does: it accepts neither `--sandbox` nor `-C`,
   * because a resumed session already carries the sandbox policy and working root it was started
   * with. Passing them anyway is not ignored, it is a usage error that exits 2 — which is exactly how
   * every second turn failed until this was split. The first turn is therefore the only place those
   * two are set, and every later turn inherits them from the session.
   */
  return session
    ? ["exec", "resume", ...options, session, "-"]
    : ["exec", ...options, "--sandbox", SANDBOX, "-C", WORKSPACE, "-"];
}

type CodexItem = {
  id?: string;
  type?: string;
  text?: string;
  message?: string;
  command?: string;
  aggregated_output?: string;
};

type CodexEvent = {
  type?: string;
  thread_id?: string;
  item?: CodexItem;
};

async function runAgent(input: RunAgentInput): Promise<Response> {
  const encoder = new EventEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const utf8 = new TextEncoder();
      let closed = false;
      const send = (event: BaseEvent) => {
        if (closed) return;
        controller.enqueue(utf8.encode(encoder.encodeSSE(event)));
      };

      send({
        type: "RUN_STARTED",
        threadId: input.threadId,
        runId: input.runId,
      } as BaseEvent);

      const messageId = `msg_${input.runId}`;
      let textOpen = false;
      /** True once Codex has actually said something, which decides what a silent turn reports. */
      let answered = false;
      /** Recoverable problems Codex reported mid-turn. Shown only if nothing else was. */
      const notices: string[] = [];
      const openText = () => {
        if (textOpen) return;
        send({
          type: "TEXT_MESSAGE_START",
          messageId,
          role: "assistant",
        } as BaseEvent);
        textOpen = true;
      };
      const say = (text: string) => {
        openText();
        send({
          type: "TEXT_MESSAGE_CONTENT",
          messageId,
          delta: text,
        } as BaseEvent);
      };

      let child: ReturnType<typeof Bun.spawn> | null = null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let timedOut = false;
      let failure: string | null = null;

      try {
        // The image creates all three so the volume inherits them; this is the belt to that pair of
        // braces, for a deployment that mounts a host directory over one of them instead.
        await mkdir(CODEX_HOME, { recursive: true });
        await mkdir(STATE_DIR, { recursive: true });
        await mkdir(WORKSPACE, { recursive: true });

        const session = await readSession(input.threadId);
        const prompt = turnPrompt(input, session !== null);

        if (prompt.length === 0) {
          throw new Error(
            "This turn carried no message for the Bot to answer.",
          );
        }

        child = Bun.spawn([CODEX_BIN, ...codexArguments(session)], {
          stdin: new TextEncoder().encode(prompt),
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env, CODEX_HOME },
        });

        timer = setTimeout(() => {
          timedOut = true;
          child?.kill();
        }, TURN_TIMEOUT_MS);

        /*
         * stderr is drained in parallel, not after the process exits.
         *
         * Codex is loud on stderr — MCP transport warnings, OAuth refresh failures, tracing — and a
         * pipe nobody is reading fills up and blocks the writer. Waiting for `exited` before reading
         * it would therefore hang the exact turns that run long enough to produce output, which is
         * every real one. Only the tail is kept, because all this is ever used for is explaining a
         * non-zero exit.
         */
        let stderrTail = "";
        const errors = child.stderr as ReadableStream<Uint8Array>;
        const stderrDrained = (async () => {
          const decoder = new TextDecoder();
          for await (const chunk of errors) {
            stderrTail = (stderrTail + decoder.decode(chunk)).slice(-4000);
          }
        })().catch(() => {
          // A stderr that cannot be read costs the error message and nothing else.
        });

        /*
         * Codex writes one JSON object per line, and also writes lines that are not JSON at all
         * ("Reading additional input from stdin...", and any tracing that lands on stdout). Anything
         * that does not parse is skipped rather than treated as a failure: this reads a tool's
         * output, and a tool is allowed to be chatty.
         */
        let buffer = "";
        for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
          buffer += new TextDecoder().decode(chunk);
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.length === 0) continue;

            let event: CodexEvent;
            try {
              event = JSON.parse(trimmed) as CodexEvent;
            } catch {
              continue;
            }

            if (event.type === "thread.started" && event.thread_id) {
              // Written as soon as it is known, not at the end: a turn that dies half way has still
              // created a Codex session, and the next turn should continue it rather than orphan the
              // work it did.
              await writeSession(input.threadId, event.thread_id);
              continue;
            }

            if (event.type !== "item.completed" || !event.item) continue;
            const item = event.item;

            if (item.type === "agent_message" && item.text) {
              answered = true;
              say(item.text);
              continue;
            }

            if (item.type === "error" && item.message) {
              /*
               * Held, not raised, and not written straight into the transcript.
               *
               * Codex emits recoverable problems as items and carries on — the routine one being a
               * notice that its own bundled skill descriptions were truncated, which arrives on
               * every first turn and is not addressed to the person in the chat. Ending the run here
               * would hide the answer that follows; printing it would put vendor housekeeping in
               * front of somebody asking a question. So it goes to the process log always, and into
               * the transcript only if the turn ends with nothing else to show — which is the case
               * where it is the only explanation the person has.
               */
              console.warn(`codex notice (${input.threadId}): ${item.message}`);
              notices.push(item.message);
              continue;
            }

            if (item.type === "command_execution" && item.command) {
              /*
               * Shown because the alternative is a chat window that says nothing for minutes while a
               * Bot works. This is a progress line in the transcript, not an audit record: the
               * record of what Codex ran lives with Codex.
               */
              say(`\n\n\`$ ${item.command}\`\n\n`);
            }
          }
        }

        const exitCode = await child.exited;

        if (timedOut) {
          throw new Error(
            `The Bot was still working after ${Math.round(TURN_TIMEOUT_MS / 1000)}s and the turn was ended.`,
          );
        }

        if (exitCode !== 0) {
          await stderrDrained;
          /*
           * `codex exec` exits 0 even when its sandbox refused every write, so a non-zero code is a
           * genuine failure to launch or authenticate and is worth the last lines of stderr. The
           * silent-success case is the dangerous one, and it is handled by the sandbox flags being
           * correct rather than by anything readable here.
           */
          const tail = stderrTail.trim().split("\n").slice(-3).join(" ");
          throw new Error(`Codex exited with code ${exitCode}. ${tail}`.trim());
        }

        if (!answered) {
          say(
            notices.length > 0
              ? `Codex finished the turn without answering. It reported: ${notices.join(" ")}`
              : "Codex finished the turn without saying anything.",
          );
        }
      } catch (error) {
        failure =
          error instanceof Error ? error.message : "The Bot could not answer.";
      } finally {
        if (timer) clearTimeout(timer);
        if (child && child.exitCode === null) child.kill();

        if (textOpen) {
          send({ type: "TEXT_MESSAGE_END", messageId } as BaseEvent);
        }

        if (failure) {
          send({ type: "RUN_ERROR", message: failure } as BaseEvent);
        } else {
          send({
            type: "RUN_FINISHED",
            threadId: input.threadId,
            runId: input.runId,
          } as BaseEvent);
        }

        closed = true;
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": encoder.getContentType(),
      "cache-control": "no-cache",
      connection: "keep-alive",
    },
  });
}

/*
 * Guarded so importing this file does not bind a port. The pure helpers above are unit-tested, and a
 * test run that started a real server would fight for the port with anything else running.
 */
if (import.meta.main) {
  serve({
    port: PORT,
    // Codex turns are long. The default would close the connection while the Bot is still working.
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return Response.json({ status: "ok", model: MODEL || "codex default" });
      }

      if (url.pathname === "/ag-ui" && request.method === "POST") {
        if (!hasManagedAgentToken(request, MANAGED_AGENT_TOKEN)) {
          return Response.json({ error: "Unauthorized." }, { status: 401 });
        }
        const input = (await request.json()) as RunAgentInput;
        return runAgent(input);
      }

      return Response.json({ error: "Not found." }, { status: 404 });
    },
  });

  console.info(`agent-codex listening on http://localhost:${PORT}/ag-ui`);
}
