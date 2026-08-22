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

  /**
   * `--approve-for-me` recusa conviver com `--sandbox`: já implica workspace-write, e passar os dois
   * é erro de uso com exit 2, não um flag ignorado. Sem aprovação nenhuma, por outro lado, toda
   * chamada de ferramenta MCP volta como "requires approval" e o turno termina explicando que não
   * deu — que na tela é indistinguível da ferramenta não existir. Os dois lados dessa borda estão
   * travados aqui porque nenhum deles falha de um jeito legível.
   */
  test("aprovando, não passa --sandbox junto", () => {
    const args = codexArguments(null, { OPENBOT_RUN: "r" });

    expect(args).toContain("--approve-for-me");
    expect(args).not.toContain("--sandbox");
  });

  test("sem credenciais, mantém o sandbox e não aprova nada", () => {
    const args = codexArguments(null);

    expect(args).toContain("--sandbox");
    expect(args).not.toContain("--approve-for-me");
  });

  test("um turno retomado também aprova, e o session id fica por último", () => {
    const args = codexArguments("sessao-1", { OPENBOT_RUN: "r" });

    expect(args).toContain("--approve-for-me");
    expect(args).not.toContain("--sandbox");
    expect(args.slice(-2)).toEqual(["sessao-1", "-"]);
  });

  test("as credenciais viram env do servidor MCP, com as aspas do TOML", () => {
    expect(codexArguments(null, { OPENBOT_RUN: "abc" })).toContain(
      'mcp_servers.openbot.env.OPENBOT_RUN="abc"',
    );
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
