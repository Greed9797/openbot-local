import type { Message } from "@ag-ui/core";
import { normalizeToolCall } from "@/lib/copilot/thread-messages";

/**
 * Transcript projection that pairs assistant tool calls with later tool-result messages.
 */

export type VisibleChatItem =
  | { kind: "text"; id: string; role: "user" | "assistant"; text: string }
  | {
      kind: "tool";
      id: string;
      toolCallId: string;
      name: string;
      args: string;
      /** The result, once there is one. Absent means the call has no answer yet. */
      result?: string;
      /** True while the call belongs to the turn in flight. */
      active: boolean;
    };

/** A tool result, as it arrives, its own message, pointing back at the call it answers. */
type ToolResultMessage = { role: "tool"; toolCallId: string; content?: string };

function isToolResult(
  message: Readonly<Message>,
): message is Readonly<Message> & ToolResultMessage {
  return message.role === "tool" && "toolCallId" in message;
}

function userText(message: Readonly<Message>): string {
  const content: unknown =
    "content" in message ? message.content : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (part): part is { type: "text"; text: string } =>
          typeof part === "object" &&
          part !== null &&
          "type" in part &&
          part.type === "text" &&
          "text" in part &&
          typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("\n");
  }
  return "";
}

/**
 * Messages to drawn rows, deduplicated for replays.
 *
 * Same policy as history normalization: first position wins, newest version
 * wins, tool calls union by call id. Two different ids stay distinct even
 * with identical text. Visual ids are prefixed so a message and a tool call
 * sharing one id never collide as React keys.
 */
export function toVisibleChatItems(
  messages: ReadonlyArray<Readonly<Message>>,
  busy = false,
): VisibleChatItem[] {
  // Newest version per message id, first position kept.
  const order: string[] = [];
  const byId = new Map<string, Readonly<Message>>();
  for (const message of messages) {
    const id: unknown = "id" in message ? message.id : undefined;
    if (typeof id !== "string" || id.length === 0) continue;
    if (!byId.has(id)) order.push(id);
    byId.set(id, message);
  }
  const deduped = order.map((id) => byId.get(id)) as Readonly<Message>[];

  // Last result per call id wins; an empty string is terminal, not missing.
  const results = new Map<string, string | undefined>();
  for (const message of deduped) {
    if (isToolResult(message)) {
      const content: unknown = message.content;
      results.set(
        message.toolCallId,
        typeof content === "string" ? content : "",
      );
    }
  }

  const lastUserIndex = deduped.findLastIndex(
    (message) => message.role === "user",
  );

  const items: VisibleChatItem[] = [];
  const seenTools = new Map<string, number>();
  deduped.forEach((message, messageIndex) => {
    if (message.role === "assistant") {
      const content: unknown =
        "content" in message ? message.content : undefined;
      if (typeof content === "string" && content.length > 0) {
        const id: unknown = "id" in message ? message.id : "";
        items.push({
          kind: "text",
          id: `message:${String(id)}`,
          role: "assistant",
          text: content,
        });
      }
      const rawCalls: unknown =
        "toolCalls" in message ? message.toolCalls : undefined;
      if (!Array.isArray(rawCalls)) return;
      for (const entry of rawCalls) {
        let callId: string;
        let name: string;
        let args: string;
        try {
          const call = normalizeToolCall(entry);
          callId = call.id;
          name = call.function.name;
          args = call.function.arguments;
        } catch {
          continue;
        }
        const existing = seenTools.get(callId);
        const result = results.has(callId)
          ? results.get(callId)
          : undefined;
        const active =
          result === undefined && busy && messageIndex > lastUserIndex;
        if (existing !== undefined) {
          // Replay of the same call: newest version at first position, partial
          // args never erase arguments already known.
          const prior = items[existing];
          if (prior?.kind === "tool") {
            const mergedArgs =
              args !== "{}" ? args : prior.args;
            const mergedName = name.length > 0 ? name : prior.name;
            items[existing] = {
              ...prior,
              name: mergedName,
              args: mergedArgs,
              ...(result === undefined ? {} : { result }),
              active,
            };
          }
          continue;
        }
        seenTools.set(callId, items.length);
        items.push({
          kind: "tool",
          id: `tool:${callId}`,
          toolCallId: callId,
          name,
          args,
          ...(result === undefined ? {} : { result }),
          active,
        });
      }
      return;
    }

    if (message.role !== "user") return;

    const text = userText(message);
    const id: unknown = "id" in message ? message.id : "";
    if (text) {
      items.push({
        kind: "text",
        id: `message:${String(id)}`,
        role: "user",
        text,
      });
    }
  });
  return items;
}
