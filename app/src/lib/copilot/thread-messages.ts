import type { Message, ToolCall } from "@ag-ui/core";
import { tryClient } from "@/lib/client";

/**
 * History failed to load or was unreadable.
 *
 * Thrown rather than answered with an empty conversation: an empty array means
 * "this thread has nothing in it", and answering that for a thread that does
 * is how a reload silently truncates a conversation.
 */
export class ThreadHistoryError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ThreadHistoryError";
    if (status !== undefined) this.status = status;
  }
}

type FlattenedToolCall = {
  id?: unknown;
  name?: unknown;
  args?: unknown;
};

type CanonicalToolCall = {
  id?: unknown;
  type?: unknown;
  function?: { name?: unknown; arguments?: unknown };
};

function argsToString(args: unknown): string {
  if (typeof args === "string") return args;
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args) ?? "{}";
  } catch {
    return "{}";
  }
}

/**
 * One tool call in canonical AG-UI shape, from either wire format.
 *
 * Accepts `{id,type:"function",function:{name,arguments}}` and the flattened
 * REST shape `{id,name,args}` the local thread endpoint emits (see
 * server/node_modules thread handler mapping `function.name` to `name`).
 * Arguments pass through untouched when already a string — including partial
 * streaming JSON, which the projection must never try to parse.
 */
export function normalizeToolCall(value: unknown): ToolCall {
  if (typeof value !== "object" || value === null) {
    throw new ThreadHistoryError("Thread history holds an invalid tool call.");
  }
  const id = "id" in value ? value.id : undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw new ThreadHistoryError("Thread history holds a tool call without id.");
  }
  const fn = "function" in value ? value.function : undefined;
  const fnName =
    typeof fn === "object" && fn !== null && "name" in fn ? fn.name : undefined;
  const flatName = "name" in value ? value.name : undefined;
  const name =
    typeof fnName === "string"
      ? fnName
      : typeof flatName === "string"
        ? flatName
        : null;
  if (name === null || name.length === 0) {
    throw new ThreadHistoryError("Thread history holds a tool call without name.");
  }
  const fnArgs =
    typeof fn === "object" && fn !== null && "arguments" in fn
      ? fn.arguments
      : undefined;
  const flatArgs = "args" in value ? value.args : undefined;
  const args =
    fnArgs !== undefined
      ? argsToString(fnArgs)
      : flatArgs !== undefined
        ? argsToString(flatArgs)
        : "{}";
  return { id, type: "function", function: { name, arguments: args } };
}

function mergeToolCall(kept: ToolCall, next: ToolCall): ToolCall {
  const args =
    next.function.arguments !== "{}"
      ? next.function.arguments
      : kept.function.arguments;
  const name =
    next.function.name.length > 0 ? next.function.name : kept.function.name;
  if (args === kept.function.arguments && name === kept.function.name) return kept;
  return { id: kept.id, type: "function", function: { name, arguments: args } };
}

function contentToMessage(
  id: string,
  role: string,
  raw: Record<string, unknown>,
): Message {
  const content: unknown = raw.content;
  const base: Record<string, unknown> = { id, role };
  if (typeof raw.name === "string") base.name = raw.name;

  if (role === "assistant") {
    if (typeof content === "string" || content === undefined) {
      if (content !== undefined) base.content = content;
    } else if (content === null) {
      // No content; tool calls below may still carry the turn.
    } else {
      base.content = argsToString(content);
    }
    const rawCalls: unknown = raw.toolCalls;
    if (rawCalls !== undefined) {
      if (!Array.isArray(rawCalls)) {
        throw new ThreadHistoryError("Thread history holds invalid tool calls.");
      }
      const merged = new Map<string, ToolCall>();
      for (const entry of rawCalls) {
        const call = normalizeToolCall(entry);
        const kept = merged.get(call.id);
        merged.set(call.id, kept ? mergeToolCall(kept, call) : call);
      }
      if (merged.size > 0) base.toolCalls = [...merged.values()];
    }
    // Built field-by-field above; the shape matches the assistant variant.
    const assistant: Message = base as Message;
    return assistant;
  }

  if (role === "tool") {
    const toolCallId: unknown = raw.toolCallId;
    if (typeof toolCallId !== "string" || toolCallId.length === 0) {
      throw new ThreadHistoryError("Thread history holds a tool result without call id.");
    }
    base.toolCallId = toolCallId;
    // An empty-string result is a terminal answer, not a missing one.
    base.content =
      typeof content === "string"
        ? content
        : content === undefined || content === null
          ? ""
          : argsToString(content);
    if (typeof raw.error === "string") base.error = raw.error;
    const tool: Message = base as Message;
    return tool;
  }

  // user, system, developer and anything else the runtime stored: keep the
  // content untouched, including multimodal arrays. Never String() an object
  // into "[object Object]".
  if (typeof content === "string" || Array.isArray(content)) {
    base.content = Array.isArray(content) ? [...content] : content;
  } else if (content === undefined) {
    // System/developer messages always carry content; a missing one is corrupt.
  } else if (content === null) {
    // Keep absent rather than rendering "null".
  } else {
    base.content = argsToString(content);
  }
  const other: Message = base as Message;
  return other;
}


/**
 * Stored history in canonical AG-UI shape, in memory only.
 *
 * Accepts the parsed `messages` array or the whole `{messages}` envelope.
 * Anything structurally invalid throws ThreadHistoryError — never an empty
 * array, which would read as "no conversation" and truncate the transcript.
 * Never mutates its input. Deduplicates by message id keeping first position
 * and newest version; two different ids stay distinct even with identical
 * text or commands.
 */
export function normalizeThreadMessages(value: unknown): Message[] {
  const list: unknown[] | null = Array.isArray(value)
    ? value
    : typeof value === "object" &&
        value !== null &&
        "messages" in value &&
        Array.isArray(value.messages)
      ? value.messages
      : null;
  if (list === null) {
    throw new ThreadHistoryError("Thread history payload is invalid.");
  }
  const order: string[] = [];
  const byId = new Map<string, Message>();
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) {
      throw new ThreadHistoryError("Thread history holds an invalid message.");
    }
    if (!("id" in entry) || !("role" in entry)) {
      throw new ThreadHistoryError("Thread history holds a message without id.");
    }
    const id: unknown = entry.id;
    const role: unknown = entry.role;
    if (typeof id !== "string" || id.length === 0) {
      throw new ThreadHistoryError("Thread history holds a message without id.");
    }
    if (typeof role !== "string" || role.length === 0) {
      throw new ThreadHistoryError("Thread history holds a message without role.");
    }
    const fields: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(entry)) fields[key] = val;
    const next = contentToMessage(id, role, fields);
    const kept = byId.get(id);
    if (!kept) {
      order.push(id);
      byId.set(id, next);
      continue;
    }
    // Newest version wins at its first position; tool calls union by call id
    // so a partial update never erases arguments already known.
    if (
      kept.role === "assistant" &&
      next.role === "assistant" &&
      "toolCalls" in kept &&
      "toolCalls" in next
    ) {
      const keptCalls =
        "toolCalls" in kept && Array.isArray(kept.toolCalls)
          ? kept.toolCalls
          : [];
      const nextCalls =
        "toolCalls" in next && Array.isArray(next.toolCalls)
          ? next.toolCalls
          : [];
      const merged = new Map<string, ToolCall>();
      for (const call of keptCalls) {
        if (typeof call.id === "string") merged.set(call.id, call);
      }
      for (const call of nextCalls) {
        if (typeof call.id !== "string") continue;
        const prior = merged.get(call.id);
        merged.set(call.id, prior ? mergeToolCall(prior, call) : call);
      }
      // Both sides already validated; the spread only unions their tool calls.
      const mergedMessage: Message = { ...next, toolCalls: [...merged.values()] };
      byId.set(id, mergedMessage);
    } else {
      byId.set(id, next);
    }
  }
  return order.map((id) => {
    const message = byId.get(id);
    if (!message) throw new ThreadHistoryError("Thread history holds an invalid message.");
    return message;
  });
}

/**
 * The messages a thread already holds, for restoring a conversation somebody comes back to.
 *
 * Fail-closed by throwing: network errors, non-OK HTTP and invalid payloads
 * all reject. A successful `{messages:[]}` is still a genuinely empty
 * conversation. No fallback hides corruption.
 */
export async function readThreadMessages(
  threadId: string,
  agentId: string,
): Promise<Message[]> {
  let response: Response;
  try {
    response = await tryClient(
      `/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${encodeURIComponent(agentId)}`,
    );
  } catch (error) {
    throw new ThreadHistoryError(
      error instanceof Error ? error.message : "Could not load thread history.",
    );
  }
  if (!response.ok) {
    throw new ThreadHistoryError(
      "Could not load thread history.",
      response.status,
    );
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ThreadHistoryError("Thread history payload is invalid.", response.status);
  }
  return normalizeThreadMessages(payload);
}
