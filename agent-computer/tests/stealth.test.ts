import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserFingerprintWithHeaders } from "fingerprint-generator";
import {
  isStealthEnabled,
  loadFingerprint,
  stealthUserAgent,
} from "../src/stealth";

const fake = (ua: string): BrowserFingerprintWithHeaders =>
  ({
    fingerprint: { navigator: { userAgent: ua } },
    headers: { "user-agent": ua },
  }) as unknown as BrowserFingerprintWithHeaders;

async function sandbox(): Promise<string> {
  return mkdtemp(join(tmpdir(), "stealth-test-"));
}

describe("fingerprint por Bot", () => {
  test("cria na primeira vez e reusa nas seguintes", async () => {
    const root = await sandbox();
    let generated = 0;
    const generate = () => {
      generated++;
      return fake("UA-stable");
    };
    const first = await loadFingerprint(root, "bot-a", generate);
    expect(first.headers["user-agent"]).toBe("UA-stable");
    const second = await loadFingerprint(root, "bot-a", generate);
    expect(second).toEqual(first);
    expect(generated).toBe(1);
  });

  test("isola um Bot do outro", async () => {
    const root = await sandbox();
    await loadFingerprint(root, "bot-a", () => fake("UA-a"));
    await loadFingerprint(root, "bot-b", () => fake("UA-b"));
    const a: unknown = JSON.parse(
      await readFile(join(root, ".fingerprints", "bot-a.json"), "utf8"),
    );
    const b: unknown = JSON.parse(
      await readFile(join(root, ".fingerprints", "bot-b.json"), "utf8"),
    );
    expect((a as { headers: { "user-agent": string } }).headers["user-agent"]).toBe(
      "UA-a",
    );
    expect((b as { headers: { "user-agent": string } }).headers["user-agent"]).toBe(
      "UA-b",
    );
  });

  test("arquivo corrompido regenera em vez de quebrar o launch", async () => {
    const root = await sandbox();
    await loadFingerprint(root, "bot-a", () => fake("UA-1"));
    await writeFile(join(root, ".fingerprints", "bot-a.json"), "lixo{{{");
    const recovered = await loadFingerprint(root, "bot-a", () => fake("UA-2"));
    expect(recovered.headers["user-agent"]).toBe("UA-2");
  });
});

describe("user-agent do fingerprint", () => {
  test("usa o do fingerprint quando existe", () => {
    expect(stealthUserAgent(fake("UA-x"))).toBe("UA-x");
  });

  test("ausente sem fingerprint ou sem header", () => {
    expect(stealthUserAgent(null)).toBeUndefined();
    expect(
      stealthUserAgent({
        fingerprint: {},
        headers: {},
      } as unknown as BrowserFingerprintWithHeaders),
    ).toBeUndefined();
  });
});

describe("escape hatch", () => {
  test("ligado por padrão, COMPUTER_STEALTH=off desliga", () => {
    expect(isStealthEnabled({} as NodeJS.ProcessEnv)).toBe(true);
    expect(isStealthEnabled({ COMPUTER_STEALTH: "off" } as NodeJS.ProcessEnv)).toBe(
      false,
    );
  });
});
