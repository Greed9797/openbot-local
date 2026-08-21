import { describe, expect, test } from "bun:test";
import { codexArguments, turnPrompt } from "../src/index";

/**
 * `exec` and `exec resume` do not take the same flags.
 *
 * `resume` accepts neither `--sandbox` nor `-C`, because the session it resumes already carries
 * both. Passing them is not ignored: Codex exits 2 with a usage error, which showed up as every
 * second turn in a conversation failing while the first one worked. That asymmetry is invisible in
 * the code unless something asserts it.
 */
describe("codex arguments", () => {
  test("a first turn sets the sandbox and the working root", () => {
    const args = codexArguments(null);

    expect(args[0]).toBe("exec");
    expect(args).toContain("--sandbox");
    expect(args).toContain("-C");
    expect(args.at(-1)).toBe("-");
  });

  test("a resumed turn passes neither, and names the session last", () => {
    const args = codexArguments("session-123");

    expect(args.slice(0, 2)).toEqual(["exec", "resume"]);
    expect(args).not.toContain("--sandbox");
    expect(args).not.toContain("-C");
    // The session id is positional and must come after the options, immediately before the prompt.
    expect(args.slice(-2)).toEqual(["session-123", "-"]);
  });

  test("the sandbox is never handed the whole machine", () => {
    expect(codexArguments(null)).not.toContain("danger-full-access");
  });
});

describe("turn prompt", () => {
  const messages = [
    { id: "s1", role: "system", content: "You are on call." },
    { id: "u1", role: "user", content: "first question" },
    { id: "a1", role: "assistant", content: "first answer" },
    { id: "u2", role: "user", content: "second question" },
  ];
  const input = { threadId: "t", runId: "r", messages } as never;

  test("a first turn carries the standing role and the question", () => {
    const prompt = turnPrompt(input, false);

    expect(prompt).toContain("You are on call.");
    expect(prompt).toContain("second question");
  });

  test("a resumed turn carries only the newest question", () => {
    const prompt = turnPrompt(input, true);

    // Codex is holding the rest itself. Replaying it would bill the subscription for a transcript
    // the model already remembers writing.
    expect(prompt).toBe("second question");
  });
});
