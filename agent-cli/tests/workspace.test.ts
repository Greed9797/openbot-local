import { expect, test } from "bun:test";
import type { Subprocess } from "bun";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// A local executable observes the actual files; no provider or account is contacted.
// Cross-process filesystem readiness needs real I/O; bounded polling checks a condition, not elapsed time.
test("queued cancellation preserves active files; failure releases the next isolated turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "openbot-workspace-"));
  let child: Subprocess<"ignore", "pipe", "pipe"> | undefined;
  try {
    const binary = join(root, "opencode");
    await writeFile(binary, `#!${process.execPath}
const name = process.argv.at(-1).split(": ").at(-1);
const config = await Bun.file("opencode.json").text();
const skill = await Bun.file(".openbot-skills/" + name + "/SKILL.md").text();
await Bun.write(name + ".started", "ready");
if (name === "first") {
  const deadline = Date.now() + 4000;
  while (!(await Bun.file("release").exists())) {
    if (Date.now() > deadline) throw new Error("release timeout");
    await Bun.sleep(5);
  }
}
if (name === "failed") process.exit(7);
const unchanged = config === await Bun.file("opencode.json").text();
console.log(JSON.stringify({type:"text",part:{text:JSON.stringify({name, unchanged, assertion:JSON.parse(config).mcp.openbot.environment.OPENBOT_RUN, skill})}}));
`);
    await chmod(binary, 0o700);
    const entry = resolve(import.meta.dir, "../src/index.ts");
    const runner = `
import { runAgent } from ${JSON.stringify(entry)};
const input = (name) => ({threadId:name,runId:name,state:{},tools:[],context:[],messages:[{id:name,role:"user",content:name}],forwardedProps:{openbotRun:name,skills:[{slug:name,title:name,summary:name,instructions:"ONLY-"+name}]}});
const active = new AbortController();
const first = await runAgent(input("first"), active.signal);
const waitFile = async (name) => { const end = Date.now()+4000; while(!(await Bun.file(name).exists())) { if(Date.now()>end) throw new Error("file timeout: "+name); await Bun.sleep(5); } };
await waitFile("first.started");
const cancelled = new AbortController();
const second = await runAgent(input("cancelled"), cancelled.signal);
const third = await runAgent(input("failed"), new AbortController().signal);
const fourth = await runAgent(input("last"), new AbortController().signal);
cancelled.abort(new Error("cancelled in queue"));
const cancelledOutput = await second.text();
const beforeRelease = JSON.parse(await Bun.file("opencode.json").text()).mcp.openbot.environment.OPENBOT_RUN;
await Bun.write("release", "go");
const outputs = await Promise.all([first.text(), third.text(), fourth.text()]);
console.log("RESULT:"+JSON.stringify({cancelledOutput,beforeRelease,outputs,cancelledStarted:await Bun.file("cancelled.started").exists()}));
`;
    child = Bun.spawn([process.execPath, "--eval", runner], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${root}:${process.env.PATH}`,
        AGENT_CLI: "opencode",
        AGENT_CLI_WORKSPACE: root,
        AGENT_CLI_AUTH_JSON: "",
        OPENBOT_AGENT_TOKEN: "",
        AGENT_CLI_TURN_TIMEOUT_MS: "5000",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    const resultLine = stdout.split("\n").find((line) => line.startsWith("RESULT:"));
    if (!resultLine) throw new Error(`Missing scenario result: ${stdout}`);
    const result = JSON.parse(resultLine.slice(7));
    expect(result.cancelledStarted).toBe(false);
    expect(result.beforeRelease).toBe("first");
    expect(result.cancelledOutput).toContain("RUN_ERROR");
    const content = (stream: string) => stream.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).filter((event) => event.type === "TEXT_MESSAGE_CONTENT").map((event) => event.delta).join("");
    expect(JSON.parse(content(result.outputs[0]))).toEqual({name:"first", unchanged:true, assertion:"first", skill:"# first\n\nONLY-first\n"});
    expect(result.outputs[1]).toContain("RUN_ERROR");
    expect(JSON.parse(content(result.outputs[2]))).toEqual({name:"last", unchanged:true, assertion:"last", skill:"# last\n\nONLY-last\n"});
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await child.exited;
    }
    await rm(root, { recursive: true, force: true });
  }
}, 15_000);
