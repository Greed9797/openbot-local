/**
 * Stealth do navegador: a mesma técnica do steel-browser, sem o servidor dele.
 *
 * O steel-browser é um servidor de sessão única (um browser por instância), o que não
 * cabe neste processo multi-Bot. O que cabe — e é o que realmente passa por
 * anti-bot — são as três técnicas portadas aqui, com as mesmas bibliotecas:
 *
 *   1. Fingerprint realista (fingerprint-generator), restrito ao que este Chromium é:
 *      Chrome desktop em Linux. Gerar Safari/Windows num Chromium Linux é mais
 *      detectável do que não fazer nada.
 *   2. Injeção no contexto (fingerprint-injector), que remenda navigator, canvas,
 *      fontes, WebGL e os headers injetáveis.
 *   3. Remoção de `--enable-automation` do launch, feita em profiles.ts.
 *
 * Um fingerprint por Bot, gravado em disco e reutilizado: trocar de "dispositivo" a
 * cada boot parece automação, não pessoa. Escape hatch: COMPUTER_STEALTH=off.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  FingerprintGenerator,
  type BrowserFingerprintWithHeaders,
} from "fingerprint-generator";
import { FingerprintInjector } from "fingerprint-injector";
import type { BrowserContext } from "playwright";

export function isStealthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.COMPUTER_STEALTH !== "off";
}

export const stealthEnabled = isStealthEnabled();

const generator = new FingerprintGenerator({
  browsers: ["chrome"],
  devices: ["desktop"],
  operatingSystems: ["linux"],
});

const fingerprintPath = (root: string, botId: string): string =>
  join(root, ".fingerprints", `${botId}.json`);

function valid(
  parsed: unknown,
): parsed is BrowserFingerprintWithHeaders {
  return (
    typeof parsed === "object" &&
    parsed !== null &&
    typeof (parsed as { fingerprint?: unknown }).fingerprint === "object" &&
    typeof (parsed as { headers?: unknown }).headers === "object"
  );
}

/**
 * O fingerprint deste Bot, estável entre restarts. Gera na primeira vez e
 * regenera se o arquivo sumir ou corromper — nunca quebra o launch por isso.
 */
export async function loadFingerprint(
  root: string,
  botId: string,
  generate: () => BrowserFingerprintWithHeaders = () =>
    generator.getFingerprint(),
): Promise<BrowserFingerprintWithHeaders> {
  const path = fingerprintPath(root, botId);
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (valid(parsed)) return parsed;
  } catch {
    // Ausente ou ilegível: gera abaixo.
  }
  const fresh = generate();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(fresh));
  return fresh;
}

/** O user-agent do contexto precisa ser o do fingerprint, não o do Playwright. */
export function stealthUserAgent(
  fingerprint: BrowserFingerprintWithHeaders | null,
): string | undefined {
  const ua = fingerprint?.headers["user-agent"];
  return typeof ua === "string" && ua.length > 0 ? ua : undefined;
}

/** Anexa a injeção ao contexto. Vale para navegações futuras; o primeiro
 * abrir_pagina do Bot já carrega a página com ela ativa. */
export async function applyStealth(
  context: BrowserContext,
  fingerprint: BrowserFingerprintWithHeaders,
): Promise<void> {
  await new FingerprintInjector().attachFingerprintToPlaywright(
    context,
    fingerprint,
  );
}
