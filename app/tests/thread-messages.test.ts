import { describe, expect, test } from "bun:test";
import {
  normalizeThreadMessages,
  readThreadMessages,
  ThreadHistoryError,
} from "../src/lib/copilot/thread-messages";

const canonical = [
  { id: "u1", role: "user", content: "run ls" },
  {
    id: "a1",
    role: "assistant",
    toolCalls: [
      {
        id: "t1",
        type: "function",
        function: { name: "codex_command", arguments: '{"command":"ls"}' },
      },
    ],
  },
  { id: "r1", role: "tool", toolCallId: "t1", content: "ok" },
];

const flattened = [
  { id: "u1", role: "user", content: "run ls" },
  {
    id: "a1",
    role: "assistant",
    toolCalls: [{ id: "t1", name: "codex_command", args: '{"command":"ls"}' }],
  },
  { id: "r1", role: "tool", toolCallId: "t1", content: "ok" },
];

describe("normalizing stored history", () => {
  test("flattened REST and AG-UI project to the same canonical shape", () => {
    const fromCanonical = normalizeThreadMessages({ messages: canonical });
    const fromFlat = normalizeThreadMessages({ messages: flattened });
    expect(fromFlat).toEqual(fromCanonical);
    const call = fromFlat[1];
    if (call.role !== "assistant" || !("toolCalls" in call) || !call.toolCalls) {
      throw new Error("expected assistant tool call");
    }
    expect(call.toolCalls[0]?.function.arguments).toBe('{"command":"ls"}');
    // The old crash was reading .function.arguments off the flattened shape.
    expect(() => call.toolCalls?.[0]?.function.arguments).not.toThrow();
  });

  test("an empty-string result is preserved, not dropped", () => {
    const out = normalizeThreadMessages({
      messages: [
        {
          id: "a1",
          role: "assistant",
          toolCalls: [{ id: "t1", name: "x", args: "{}" }],
        },
        { id: "r1", role: "tool", toolCallId: "t1", content: "" },
      ],
    });
    const result = out.find((m) => m.role === "tool");
    expect(result).toMatchObject({ content: "" });
  });

  test("duplicate message ids keep first position and newest version", () => {
    const out = normalizeThreadMessages([
      { id: "u1", role: "user", content: "first" },
      { id: "u1", role: "user", content: "second" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ content: "second" });
  });

  test("partial tool args never erase arguments already known", () => {
    const out = normalizeThreadMessages([
      {
        id: "a1",
        role: "assistant",
        toolCalls: [{ id: "t1", name: "codex_command", args: '{"command":"ls"}' }],
      },
      {
        id: "a1",
        role: "assistant",
        toolCalls: [{ id: "t1", name: "codex_command", args: "{}" }],
      },
    ]);
    expect(out).toHaveLength(1);
    const msg = out[0];
    if (msg.role !== "assistant" || !("toolCalls" in msg) || !msg.toolCalls) {
      throw new Error("expected tool calls");
    }
    expect(msg.toolCalls[0]?.function.arguments).toBe('{"command":"ls"}');
  });

  test("different ids stay distinct with identical text", () => {
    const out = normalizeThreadMessages([
      { id: "a1", role: "user", content: "same" },
      { id: "a2", role: "user", content: "same" },
    ]);
    expect(out).toHaveLength(2);
  });

  test("object arguments stringify and input is not mutated", () => {
    const input = {
      messages: [
        {
          id: "a1",
          role: "assistant",
          toolCalls: [{ id: "t1", name: "x", args: { command: "ls" } }],
        },
      ],
    };
    const snapshot = JSON.parse(JSON.stringify(input)) as unknown;
    const out = normalizeThreadMessages(input);
    expect(input).toEqual(snapshot);
    const msg = out[0];
    if (msg.role !== "assistant" || !("toolCalls" in msg) || !msg.toolCalls) {
      throw new Error("expected tool calls");
    }
    expect(msg.toolCalls[0]?.function.arguments).toBe('{"command":"ls"}');
  });

  test("multimodal user content is preserved", () => {
    const parts = [
      { type: "text", text: "look" },
      {
        type: "image",
        source: { type: "url", value: "https://example.test/x.png" },
      },
    ];
    const out = normalizeThreadMessages([
      { id: "u1", role: "user", content: parts },
    ]);
    expect(out[0]).toMatchObject({ content: parts });
  });

  test("structurally invalid payloads throw, never answer empty", () => {
    expect(() => normalizeThreadMessages({ messages: [{ role: "user" }] })).toThrow(
      ThreadHistoryError,
    );
    expect(() => normalizeThreadMessages({ nope: [] })).toThrow(ThreadHistoryError);
    expect(() => normalizeThreadMessages({ messages: "nope" })).toThrow(
      ThreadHistoryError,
    );
  });
});

describe("reading thread history", () => {
  test("non-OK HTTP rejects instead of answering empty", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("oops", { status: 503 })) as typeof fetch;
    try {
      await expect(readThreadMessages("t", "a")).rejects.toBeInstanceOf(
        ThreadHistoryError,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("invalid payload rejects instead of answering empty", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: [{ role: "user" }] }), {
        status: 200,
      })) as typeof fetch;
    try {
      await expect(readThreadMessages("t", "a")).rejects.toBeInstanceOf(
        ThreadHistoryError,
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a genuinely empty conversation still reads empty", async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ messages: [] }), {
        status: 200,
      })) as typeof fetch;
    try {
      await expect(readThreadMessages("t", "a")).resolves.toEqual([]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
