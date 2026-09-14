import { describe, expect, test } from "bun:test";
import type { Message } from "@ag-ui/core";
import { toVisibleChatItems } from "../src/components/channels/chat-messages";

const assistantWith = (
  id: string,
  toolCallId: string,
  args: string,
): Message => ({
  id,
  role: "assistant",
  toolCalls: [
    {
      id: toolCallId,
      type: "function",
      function: { name: "codex_command", arguments: args },
    },
  ],
});

const toolResult = (id: string, toolCallId: string, content: string): Message => ({
  id,
  role: "tool",
  toolCallId,
  content,
});

describe("projecting chat items", () => {
  test("replay of the same call id draws one activity", () => {
    const items = toVisibleChatItems(
      [
        assistantWith("a1", "t1", '{"command":"ls"}'),
        assistantWith("a2", "t1", '{"command":"ls"}'),
        toolResult("r1", "t1", "ok"),
      ],
      false,
    );
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(1);
  });

  test("same command with different ids draws two activities", () => {
    const items = toVisibleChatItems(
      [
        assistantWith("a1", "t1", '{"command":"ls"}'),
        assistantWith("a2", "t2", '{"command":"ls"}'),
      ],
      true,
    );
    expect(items.filter((i) => i.kind === "tool")).toHaveLength(2);
  });

  test("an empty-string result counts as answered, not running", () => {
    const items = toVisibleChatItems(
      [assistantWith("a1", "t1", "{}"), toolResult("r1", "t1", "")],
      true,
    );
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ result: "" });
    if (tool?.kind !== "tool") throw new Error("expected tool");
    expect(tool.active).toBe(false);
  });

  test("a call without result is active only on a busy turn after the user", () => {
    const idle = toVisibleChatItems(
      [
        { id: "u1", role: "user", content: "hi" },
        assistantWith("a1", "t1", "{}"),
      ],
      false,
    );
    const busy = toVisibleChatItems(
      [
        { id: "u1", role: "user", content: "hi" },
        assistantWith("a1", "t1", "{}"),
      ],
      true,
    );
    expect(idle.find((i) => i.kind === "tool")).toMatchObject({ active: false });
    expect(busy.find((i) => i.kind === "tool")).toMatchObject({ active: true });
  });

  test("visual ids never collide across kinds", () => {
    const items = toVisibleChatItems(
      [
        { id: "same", role: "user", content: "hi" },
        assistantWith("a1", "same", "{}"),
      ],
      false,
    );
    const ids = items.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("message:same");
    expect(ids).toContain("tool:same");
  });

  test("flattened calls never dereference .function", () => {
    const items = toVisibleChatItems(
      [
        {
          id: "a1",
          role: "assistant",
          toolCalls: [{ id: "t1", name: "codex_command", args: '{"command":"ls"}' }],
        } as unknown as Message,
      ],
      false,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ name: "codex_command" });
  });
});
