import { GlobalRegistrator } from "@happy-dom/global-registrator";

// Bun runs test files in one process: a second unconditional register throws.
if (typeof document === "undefined") {
 GlobalRegistrator.register();
}

import { describe, expect, mock, test } from "bun:test";
import * as ActualCopilot from "@copilotkit/react-core/v2";
import type { Message } from "@ag-ui/core";

// Bound after the DOM above exists: `screen` queries `document.body` at import.
const { render, screen } = await import("@testing-library/react");

mock.module("@copilotkit/react-core/v2", () => ({
  ...ActualCopilot,
  useRenderToolCall: () => () => null,
}));

const { ChatTranscript } = await import(
  "../src/components/channels/chat-transcript"
);

function toolsMessage(id: string, names: string[]): Message {
  return {
    id,
    role: "assistant",
    content: "",
    toolCalls: names.map((name, index) => ({
      id: `${id}-call-${index}`,
      type: "function",
      function: { name, arguments: "{}" },
    })),
  } as unknown as Message;
}

function textMessage(id: string, role: "user" | "assistant", text: string): Message {
  return { id, role, content: text } as Message;
}

function renderTranscript(messages: Message[], busy = false) {
  return render(
    <ChatTranscript busy={busy} commandNames="" messages={messages} />,
  );
}

describe("grouping consecutive tool calls", () => {
  test("a run of tools folds into one Activity block", () => {
    const view = renderTranscript([
      textMessage("u1", "user", "go"),
      toolsMessage("a1", ["browse", "read_page"]),
    ]);
    expect(
      screen.getByText("2 ferramentas chamadas").tagName,
    ).toBe("SPAN");
    // The calls themselves still draw inside the block.
    expect(screen.getByText("browse")).toBeDefined();
    view.unmount();
  });

  test("a lone tool keeps its own line, with no disclosure to open", () => {
    const view = renderTranscript([
      textMessage("u1", "user", "go"),
      toolsMessage("a1", ["browse"]),
    ]);
    expect(screen.queryByText(/ferramentas chamadas/)).toBeNull();
    expect(screen.getByText("browse")).toBeDefined();
    view.unmount();
  });

  test("text between calls breaks the run into two blocks", () => {
    const view = renderTranscript([
      textMessage("u1", "user", "go"),
      toolsMessage("a1", ["browse", "read_page"]),
      textMessage("a2", "assistant", "an answer"),
      toolsMessage("a3", ["browse", "read_page"]),
    ]);
    expect(screen.getAllByText("2 ferramentas chamadas")).toHaveLength(2);
    view.unmount();
  });

  test("the block stays open while a call is in flight", () => {
    const view = renderTranscript(
      [textMessage("u1", "user", "go"), toolsMessage("a1", ["browse", "read_page"])],
      true,
    );
    const summary = screen.getByText("2 ferramentas chamadas").closest("summary");
    expect(summary?.parentElement?.hasAttribute("open")).toBe(true);
    view.unmount();
  });
});
