/**
 * The HTTP surface of durable tasks.
 *
 * Thin on purpose: every rule lives in the service, so the web UI, Telegram and an API client all
 * get the same refusals. What is decided here is who may see or steer a run — its owner, or an
 * administrator.
 */
import type { Context, MiddlewareHandler } from "hono";
import { Hono } from "hono";
import type { AppVariables } from "../auth/guards";
import type { RunVision } from "./capture";
import { captureRunScreen } from "./capture";
import type { AgentRunRow } from "./repository";
import type { AgentRunService } from "./service";
import { AgentRunError, eventView, runView, stepView } from "./service";
import type { CreateRunInput, RunStatus } from "./types";

export type RunRoutesService = AgentRunService;

/**
 * O que as rotas de imagem precisam: capturar, classificar, gravar.
 *
 * Um objeto em vez de três parâmetros soltos porque as três andam juntas — uma captura sem
 * classificação é uma imagem sem decisão de destino, e é exatamente o que não pode existir.
 */
export type { RunVision };

function statusOf(error: unknown): {
  status: 404 | 409 | 400 | 500;
  body: { error: string; code?: string };
} {
  if (error instanceof AgentRunError) {
    /*
     * `INVALID_ACTION` é o único código que descreve um pedido malformado — provedor ou modelo que
     * não existe neste deployment —, e um pedido malformado é 400, não 409. Os outros descrevem
     * estado: a tarefa não está onde o pedido supõe.
     */
    const status =
      error.code === "NOT_FOUND"
        ? 404
        : error.code === "INVALID_ACTION"
          ? 400
          : 409;
    return { status, body: { error: error.message, code: error.code } };
  }
  return {
    status: 500,
    body: { error: "The task could not be handled." },
  };
}

export function createAgentRunRoutes(
  service: RunRoutesService,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
  vision?: RunVision,
) {
  const routes = new Hono<{ Variables: AppVariables }>();

  /**
   * Who may watch or steer a run.
   *
   * Its owner, or an administrator. A run with no owner (an API client with a service token) is
   * readable by administrators only, which is the same rule the rest of the admin surface uses.
   */
  function maySee(
    row: AgentRunRow,
    actorId: string,
    isAdmin: boolean,
  ): boolean {
    if (isAdmin) return true;
    return row.userId !== null && row.userId === actorId;
  }

  async function loadVisible(
    id: string,
    context: Context<{ Variables: AppVariables }>,
  ): Promise<AgentRunRow> {
    const row = await service.getRun(id);
    if (!row) throw new AgentRunError("NOT_FOUND", `No run ${id}.`);
    if (
      !maySee(row, context.var.actor.id, context.var.actor.role === "admin")
    ) {
      // Same answer as absent, so a run id cannot be used to learn that somebody else has one.
      throw new AgentRunError("NOT_FOUND", `No run ${id}.`);
    }
    return row;
  }

  routes.post("/", requireUser, async (context) => {
    const body = (await context.req.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    const objective =
      typeof body?.objective === "string" ? body.objective.trim() : "";
    if (!objective) {
      return context.json(
        { error: "A task needs an objective.", code: "INVALID_ACTION" },
        400,
      );
    }
    const botId =
      typeof body?.botId === "string" && body.botId.trim()
        ? body.botId.trim()
        : "default";
    const headerKey = context.req.header("idempotency-key")?.trim();
    const input: CreateRunInput = {
      botId,
      userId: context.var.actor.id,
      origin:
        body?.origin === "telegram" || body?.origin === "api"
          ? body.origin
          : "web",
      objective,
      ...(typeof body?.threadId === "string"
        ? { threadId: body.threadId }
        : {}),
      ...(typeof body?.provider === "string"
        ? { provider: body.provider }
        : {}),
      ...(typeof body?.model === "string" ? { model: body.model } : {}),
      // Condição host-side opcional; o serviço valida a forma e responde 400 quando malformada.
      ...("completion" in (body ?? {})
        ? {
            completion: (body as Record<string, unknown>)
              .completion as CreateRunInput["completion"],
          }
        : {}),
      ...(typeof body?.metadata === "object" && body?.metadata !== null
        ? { metadata: body.metadata as Record<string, unknown> }
        : {}),
      idempotencyKey:
        headerKey ??
        (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null),
      ...(typeof body?.sourceMessageId === "string"
        ? { sourceMessageId: body.sourceMessageId }
        : {}),
    };
    try {
      const { run, created } = await service.createRun(
        { id: context.var.actor.id },
        input,
        context.var.actor.id,
      );
      return context.json({ run: runView(run), created }, created ? 201 : 200);
    } catch (error) {
      const { status, body: failure } = statusOf(error);
      return context.json(failure, status);
    }
  });

  routes.get("/", requireUser, async (context) => {
    const url = new URL(context.req.url);
    const statuses = (url.searchParams.get("status") ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean) as RunStatus[];
    const requested = Number.parseInt(
      url.searchParams.get("limit") ?? "50",
      10,
    );
    const isAdmin = context.var.actor.role === "admin";
    const rows = await service.listRuns({
      ...(url.searchParams.get("botId")
        ? { botId: url.searchParams.get("botId") ?? undefined }
        : {}),
      // An administrator may ask for anybody's runs; everybody else only ever sees their own.
      ...(isAdmin
        ? url.searchParams.get("userId")
          ? { userId: url.searchParams.get("userId") ?? undefined }
          : {}
        : { userId: context.var.actor.id }),
      ...(statuses.length ? { status: statuses } : {}),
      limit: Number.isFinite(requested) ? requested : 50,
    });
    return context.json({ runs: rows.map(runView) });
  });

  routes.get("/:id", requireUser, async (context) => {
    try {
      const row = await loadVisible(context.req.param("id"), context);
      return context.json({ run: runView(row) });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  routes.get("/:id/steps", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const steps = await service.steps(context.req.param("id"));
      return context.json({ steps: steps.map(stepView) });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  routes.get("/:id/events", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const after = Number.parseInt(
        new URL(context.req.url).searchParams.get("after") ?? "0",
        10,
      );
      const rows = await service.events(
        context.req.param("id"),
        Number.isFinite(after) ? after : 0,
      );
      return context.json({ events: rows.map(eventView) });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  /**
   * The run's events as a stream.
   *
   * A cursor over the events table, not a live bus: the run keeps writing whether or not anybody is
   * watching, and a browser that reconnects resumes from the last seq it saw. Polling the table is
   * also what makes this work when the run is being driven by another process.
   */
  routes.get("/:id/events/stream", requireUser, async (context) => {
    let row: AgentRunRow;
    try {
      row = await loadVisible(context.req.param("id"), context);
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
    const runId = row.id;
    const after = Number.parseInt(
      new URL(context.req.url).searchParams.get("after") ?? "0",
      10,
    );
    let cursor = Number.isFinite(after) ? after : 0;
    const signal = context.req.raw.signal;
    const encoder = new TextEncoder();
    const serviceRef = service;

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const write = (text: string) => {
          controller.enqueue(encoder.encode(text));
        };
        const poll = setInterval(() => {
          void serviceRef
            .events(runId, cursor)
            .then((events) => {
              for (const event of events) {
                cursor = event.seq;
                write(`data: ${JSON.stringify(eventView(event))}\n\n`);
              }
              return serviceRef.getRun(runId);
            })
            .then((current) => {
              if (
                current &&
                ["succeeded", "failed", "cancelled"].includes(current.status)
              ) {
                write("event: end\ndata: {}\n\n");
                clearInterval(poll);
                controller.close();
              }
            })
            .catch(() => {
              clearInterval(poll);
              controller.close();
            });
        }, 1_000);
        signal.addEventListener("abort", () => {
          clearInterval(poll);
          try {
            controller.close();
          } catch {
            // Already closed by the terminal state above.
          }
        });
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  });

  /**
   * A captura de uma tarefa, sob demanda.
   *
   * Quem pede já pode ver a tarefa; o que a rota acrescenta é a decisão sobre a imagem. Ela é
   * classificada pelo host, gravada com prazo e destinos, e devolvida como metadado — os bytes saem
   * por `GET /:id/artifacts/:artifactId`, um caminho com autorização própria, para que uma imagem
   * não viaje por acidente em toda resposta que a menciona.
   *
   * `/tela` do Telegram não gasta uma chamada de modelo por causa disto: capturar e analisar são
   * duas rotas, e esta é a primeira.
   */
  routes.post("/:id/screenshot", requireUser, async (context) => {
    if (!vision) {
      return context.json(
        { error: "Este deployment não tem navegador ligado ao runtime." },
        503,
      );
    }
    let run: AgentRunRow;
    try {
      run = await loadVisible(context.req.param("id"), context);
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
    try {
      const captured = await captureRunScreen(
        vision,
        { id: run.id, botId: run.botId },
        { stepId: null },
      );
      const { artifact, url } = captured;
      await service.recordEvent(run.id, "run.screenshot", {
        artifactId: artifact.id,
        url,
        by: context.var.actor.id,
      });
      return context.json({
        artifact: {
          id: artifact.id,
          mime: artifact.mime,
          width: artifact.width,
          height: artifact.height,
          bytes: artifact.bytes,
          classification: artifact.classification,
          protection: artifact.protection,
          allowedDestinations: artifact.allowedDestinations,
          retentionUntil: artifact.retentionUntil,
          createdAt: artifact.createdAt,
          metadata: artifact.metadata,
        },
      });
    } catch (error) {
      return context.json(
        { error: error instanceof Error ? error.message : "A captura falhou." },
        502,
      );
    }
  });

  /**
   * Os bytes de um artefato.
   *
   * A resposta mais fechada que serve: uma imagem, sem lista de metadados, sem nome de arquivo do
   * servidor no cabeçalho. A autorização é a mesma da tarefa dona do artefato, e a comparação do
   * `runId` é o que impede que um id de artefato adivinhado leia a imagem de outra pessoa.
   */
  routes.get("/:id/artifacts/:artifactId", requireUser, async (context) => {
    if (!vision) {
      return context.json({ error: "Artefatos não estão ligados." }, 503);
    }
    let run: AgentRunRow;
    try {
      run = await loadVisible(context.req.param("id"), context);
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
    const found = await vision.artifacts.read(context.req.param("artifactId"));
    if (!found || found.row.runId !== run.id) {
      return context.json({ error: "Artefato não encontrado." }, 404);
    }
    return new Response(new Uint8Array(found.bytes), {
      headers: {
        "content-type": found.row.mime,
        "content-length": String(found.bytes.byteLength),
        // Nada de cache intermediário para uma imagem de uma página autenticada.
        "cache-control": "no-store",
      },
    });
  });

  routes.post("/:id/messages", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const body = (await context.req.json().catch(() => ({}))) as {
        text?: unknown;
      };
      if (typeof body.text !== "string" || !body.text.trim()) {
        return context.json({ error: "Uma mensagem precisa de texto." }, 400);
      }
      const { run } = await service.appendMessage(
        context.req.param("id"),
        { id: context.var.actor.id },
        { text: body.text, source: "web" },
      );
      return context.json({ run: runView(run) });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  routes.get("/:id/messages", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const after = Number.parseInt(context.req.query("after") ?? "0", 10);
      const messages = await service.messages(
        context.req.param("id"),
        Number.isFinite(after) ? after : 0,
      );
      return context.json({ messages });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  routes.get("/:id/approvals", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const approvals = await service.approvals(context.req.param("id"));
      return context.json({ approvals });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  /**
   * O sim e o não de uma pessoa.
   *
   * A decisão é sobre uma aprovação, e a aprovação é sobre uma ação exata: o serviço prende as duas
   * pelo hash, e o executor só gasta o sim que ainda vale para aquela ação. Aprovar por engano é,
   * portanto, um erro de uma ação só.
   */
  routes.post("/:id/approvals/:approvalId", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const body = (await context.req.json().catch(() => ({}))) as {
        decision?: unknown;
        note?: unknown;
      };
      if (body.decision !== "approve" && body.decision !== "deny") {
        return context.json(
          { error: 'A decisão precisa ser "approve" ou "deny".' },
          400,
        );
      }
      const { run, approval } = await service.decideApproval(
        context.req.param("id"),
        context.req.param("approvalId"),
        { id: context.var.actor.id },
        body.decision === "approve" ? "approved" : "denied",
        typeof body.note === "string" ? body.note : undefined,
      );
      return context.json({
        run: runView(run),
        approval,
      });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  routes.post("/:id/pause", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const run = await service.pause(context.req.param("id"), {
        id: context.var.actor.id,
      });
      return context.json({ run: runView(run) });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  routes.post("/:id/resume", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const run = await service.resume(context.req.param("id"), {
        id: context.var.actor.id,
      });
      return context.json({ run: runView(run) });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  routes.post("/:id/cancel", requireUser, async (context) => {
    try {
      await loadVisible(context.req.param("id"), context);
      const run = await service.cancel(context.req.param("id"), {
        id: context.var.actor.id,
      });
      return context.json({ run: runView(run) });
    } catch (error) {
      const { status, body } = statusOf(error);
      return context.json(body, status);
    }
  });

  return routes;
}
