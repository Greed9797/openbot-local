import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

/**
 * O volume de perfis que veio de root, e o que recupera ele.
 *
 * A história é o incidente: um volume `public-browser-profiles` que pertencia a `0:0` deixou o
 * Chromium do Bot incapaz de abrir perfil com EACCES, enquanto o `/health` dizia ok e o container
 * seguia "healthy". O que este arquivo prova, em ordem:
 *
 *   1. O inicializador de perfis converte um volume root-owned — incluindo um perfil 0700 antigo e a
 *      sentinela que comprova que nada foi apagado — para o dono certo, sem seguir symlinks, sem
 *      mudar modo/conteúdo, e de forma idempotente.
 *   2. Num mount somente leitura, ele falha explicitamente em vez de fingir sucesso, e os dados ficam.
 *   3. A imagem que sobe o computador com esse volume abre o perfil antigo e um perfil novo de
 *      verdade, com Chromium de verdade: navega na fixture, o `/health` diz 200, diz 503 quando a raiz
 *      perde escrita, a tela entrega frames JPEG que mudam com a página, o controle recusa input sem
 *      o volante e aceita com ele, um viewer novo sobrevive ao fechamento do antigo, e um cookie com
 *      expiração atravessa a recriação do container.
 *   4. A expansão e o fechamento da tela no painel são comportamento de superfície, exercitados contra
 *      um navegador de verdade em outro teste (a suíte da superfície, na app). Aqui fica o que é do
 *      container: chegada do frame, troca de dono e estados operacionais.
 *
 * Não é parte de `bun test`. Precisa do Docker, de uma imagem construída a partir deste repo e de
 * permissões para publicar portas de loopback — por isso opt-in:
 *
 *   docker build -t openbot-recovery:test .
 *   OPENBOT_RECOVERY_SMOKE=1 bun test tests/smoke/browser-recovery.test.ts --timeout 180000
 *
 * Usa SÓ o que esta suíte cria: volume, container e imagem efêmeros, token gerado em memória, portas
 * só em loopback. Nunca toca volume, dado ou cookie real.
 */

const asked = process.env.OPENBOT_RECOVERY_SMOKE === "1";
const IMAGE = process.env.OPENBOT_RECOVERY_IMAGE ?? "openbot-recovery:test";
const FIXTURE_TITLE = "openbot-fixture";
/** O cookie sintético que prova persistência. Nunca um cookie real: é gerado aqui e morre aqui. */
const SESSION_COOKIE = `openbot-smoke-${randomUUID()}`;
const BOT = "smoke-bot";

type DockerResult = { code: number; stdout: string; stderr: string };

async function docker(args: string[]): Promise<DockerResult> {
  const proc = Bun.spawn(["docker", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return {
    code: await proc.exited,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  };
}

function requireDocker(
  result: DockerResult,
  what: string,
  command: string[],
): asserts result is DockerResult & { code: 0 } {
  if (result.code !== 0) {
    throw new Error(
      `docker ${command.join(" ")} falhou com ${result.code} (${what}):\n${result.stderr.slice(0, 2000)}`,
    );
  }
}

async function hostPort(): Promise<{
  server: ReturnType<typeof Bun.serve>;
  port: number;
}> {
  const state = {
    color: "rgb(0, 100, 200)",
    token: randomUUID(),
    mutated: false,
  };
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") {
        return new Response(
          `<!doctype html><html><head><title>${FIXTURE_TITLE}</title></head><body>` +
            `<span id="token">${state.token}</span>` +
            `<button id="hit" style="position:absolute;left:0;top:0;width:1280px;height:200px" onclick="mutate()">mutar</button>` +
            `<span id="state">${state.color}</span>` +
            `<script>async function mutate(){await fetch('/mutate',{method:'POST'});document.getElementById('state').textContent=await (await fetch('/color')).text();document.body.style.backgroundColor=await (await fetch('/color')).text();}</script>` +
            `</body></html>`,
          {
            status: 200,
            headers: {
              "content-type": "text/html",
              "set-cookie": `openbot-smoke=${SESSION_COOKIE}; Max-Age=86400; Path=/`,
            },
          },
        );
      }
      if (url.pathname === "/color" && request.method === "GET") {
        return new Response(state.color);
      }
      if (url.pathname === "/mutate" && request.method === "POST") {
        state.color = "rgb(200, 40, 40)";
        state.mutated = true;
        return new Response("ok");
      }
      if (url.pathname === "/state" && request.method === "GET") {
        return Response.json({ mutated: state.mutated, color: state.color });
      }
      if (url.pathname === "/cookies" && request.method === "GET") {
        return Response.json({
          received: request.headers.get("cookie") ?? "",
        });
      }
      return new Response("no", { status: 404 });
    },
  });
  const assigned = server.port;
  if (assigned === undefined) throw new Error("a fixture não recebeu porta");
  return { server, port: assigned };
}

/** Valida a estrutura do JPEG sem um decodificador: SOI, SOF com dimensões, EOI. */
function jpegInfo(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("não começa com SOI: não é um JPEG");
  }
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) throw new Error("marcador inválido no meio do JPEG");
    const marker = bytes[i + 1];
    if (marker === 0xd9) throw new Error("EOI antes do SOF: sem dimensões");
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const length = (bytes[i + 2] << 8) | bytes[i + 3];
    if (length < 2) throw new Error("comprimento de segmento inválido");
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      const height = (bytes[i + 5] << 8) | bytes[i + 6];
      const width = (bytes[i + 7] << 8) | bytes[i + 8];
      if (width <= 0 || height <= 0)
        throw new Error("dimensões zeradas no SOF");
      if (
        bytes[bytes.length - 2] !== 0xff ||
        bytes[bytes.length - 1] !== 0xd9
      ) {
        throw new Error("sem EOI no fim: frame truncado");
      }
      return { width, height };
    }
    i += 2 + length;
  }
  throw new Error("sem SOF: não é um JPEG decodificável");
}

/** O computador dentro do container, pelo HTTP que o servidor usaria. */
function computer(base: string, token: string, botId: string) {
  const headers = {
    "content-type": "application/json",
    "x-openbot-computer-token": token,
    "x-openbot-bot-id": botId,
  };
  return {
    url: base,
    async health(): Promise<Response> {
      return fetch(`${base}/health`);
    },
    async call(
      path: string,
      body?: unknown,
    ): Promise<{ status: number; payload: unknown }> {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return {
        status: response.status,
        payload: await response.json().catch(() => null),
      };
    },
    async get(path: string): Promise<{ status: number; payload: unknown }> {
      const response = await fetch(`${base}${path}`, { headers });
      return {
        status: response.status,
        payload: await response.json().catch(() => null),
      };
    },
  };
}

type Frame = { data: string; width: number; height: number };

/** Um espectador do /stream: guarda o último frame e conta quantos chegaram. */
function watchStream(base: string, botId: string, token: string) {
  let latest: Frame | null = null;
  let count = 0;
  const waiters: { at: number; resolve: () => void }[] = [];
  const socket = new WebSocket(
    `${base.replace(/^http/, "ws")}/stream?bot=${encodeURIComponent(botId)}&token=${encodeURIComponent(token)}`,
  );
  socket.onmessage = (event) => {
    let message: {
      type: string;
      data?: string;
      width?: number;
      height?: number;
    };
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type !== "frame" || !message.data) return;
    latest = {
      data: message.data,
      width: message.width ?? 0,
      height: message.height ?? 0,
    };
    count++;
    for (const waiter of waiters.splice(0)) {
      if (count >= waiter.at) waiter.resolve();
    }
  };
  const frames = (n: number, timeoutMs = 30_000): Promise<Frame> => {
    if (latest && count >= n) return Promise.resolve(latest);
    const { promise, resolve, reject } = Promise.withResolvers<Frame>();
    const timer = setTimeout(
      () => reject(new Error(`timeout esperando ${n} frames`)),
      timeoutMs,
    );
    waiters.push({
      at: n,
      resolve: () => {
        clearTimeout(timer);
        resolve(latest as Frame);
      },
    });
    return promise;
  };
  return {
    socket,
    frames,
    get latest(): Frame | null {
      return latest;
    },
    get count(): number {
      return count;
    },
    close() {
      socket.close();
    },
  };
}
/** Espera curta, sem o executor aninhado do `new Promise`. */
async function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const tag = `recovery-${randomUUID().slice(0, 8)}`;
const volume = `${tag}-profiles`;
const boxVolume = `${tag}-elsewhere`;
let container = "";
let boxPort = 0;
let fixturePort = 0;
let stopFixture: (() => void) | undefined;
const TOKEN = randomUUID().replace(/-/g, "");

async function containerBase(): Promise<string> {
  return `http://127.0.0.1:${boxPort}`;
}

async function runComputer(): Promise<string> {
  const name = `${tag}-computer`;
  const result = await docker([
    "run",
    "-d",
    "--name",
    name,
    "-v",
    `${volume}:/profiles`,
    "-e",
    `COMPUTER_TOKEN=${TOKEN}`,
    "-p",
    `127.0.0.1:0:4100`,
    "--entrypoint",
    "sh",
    IMAGE,
    "-c",
    "export PATH=/command:$PATH; export PORT=4100; sh /etc/s6-overlay/scripts/profiles-init.sh && exec s6-setuidgid pwuser /usr/local/bin/bun /app/agent-computer/src/index.ts",
  ]);
  requireDocker(result, "subir o computador", ["run"]);
  const portRow = await docker(["port", name, "4100"]);
  requireDocker(portRow, "descobrir a porta publicada", ["port"]);
  const match = portRow.stdout.match(/127\.0\.0\.1:(\d+)/);
  if (!match) throw new Error(`porta publicada ilegível: ${portRow.stdout}`);
  boxPort = Number(match[1]);
  container = name;
  return name;
}

async function stopComputer(): Promise<void> {
  if (!container) return;
  await docker(["rm", "-f", container]).catch(() => undefined);
  container = "";
}

async function healthOk(base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    const response = await fetch(`${base}/health`).catch(() => null);
    if (response && response.status === 200) {
      const body = (await response.json().catch(() => null)) as {
        profileStorageReady?: boolean;
      } | null;
      if (body?.profileStorageReady === true) return;
    }
    if (Date.now() > deadline) {
      throw new Error(`o computador em ${base} não ficou pronto a tempo`);
    }
    await sleep(500);
  }
}

/** Executa um comando como root dentro de uma imagem que monta o volume de perfis. */
async function asRoot(
  script: string,
  extra: string[] = [],
): Promise<DockerResult> {
  return docker([
    "run",
    "-v",
    `${volume}:/profiles`,
    "--user",
    "0:0",
    "--entrypoint",
    "sh",
    ...extra,
    IMAGE,
    "-c",
    script,
  ]);
}

beforeAll(async () => {
  if (!asked) return;
  const fixture = await hostPort();
  fixturePort = fixture.port;
  stopFixture = () => fixture.server.stop(true);

  // O volume nasce como o da VPS no incidente: raiz e perfil antigo de root.
  for (const name of [volume, boxVolume]) {
    const created = await docker(["volume", "create", name]);
    requireDocker(created, "criar volume", ["volume", "create"]);
  }
  const seed = await asRoot(
    "set -eu; " +
      "mkdir -p /profiles/risk-analyst; " +
      "chmod 755 /profiles; " +
      "chmod 700 /profiles/risk-analyst; " +
      "printf sentinel > /profiles/sentinel.txt; " +
      "printf cookies > /profiles/risk-analyst/Cookies; " +
      "chown -R 0:0 /profiles; " +
      "stat -c '%u:%g %a %n' /profiles /profiles/risk-analyst; " +
      "cat /profiles/sentinel.txt",
  );
  requireDocker(seed, "semear o volume como root", ["run"]);
  expect(seed.stdout).toContain("0:0 755 /profiles");
  expect(seed.stdout).toContain("0:0 700 /profiles/risk-analyst");
  expect(seed.stdout).toContain("sentinel");
});

afterAll(async () => {
  if (!asked) return;
  await stopComputer();
  stopFixture?.();
  await docker(["volume", "rm", volume, boxVolume]).catch(() => undefined);
});

describe.skipIf(!asked)("o inicializador antes do navegador", () => {
  test(
    "corrige o dono, preserva conteúdo e modo, e é idempotente",
    async () => {
      for (const run of [1, 2]) {
        const result = await asRoot(
          "sh /etc/s6-overlay/scripts/profiles-init.sh",
        );
        requireDocker(result, `rodar o inicializador (vez ${run})`, ["run"]);
      }
      const after = await asRoot(
        "stat -c '%u:%g %a %n' /profiles /profiles/risk-analyst; " +
          "cat /profiles/sentinel.txt; cat /profiles/risk-analyst/Cookies",
      );
      requireDocker(after, "inspecionar o volume corrigido", ["run"]);
      // A sentinela prova que nada foi apagado; o Cookies, que o perfil antigo continua legível.
      expect(after.stdout).toContain("1001:1001 755 /profiles");
      expect(after.stdout).toContain("1001:1001 700 /profiles/risk-analyst");
      expect(after.stdout).toContain("sentinel");
      expect(after.stdout).toContain("cookies");
    },
    { timeout: 120_000 },
  );

  test(
    "não segue symlink para fora nem muda o alvo",
    async () => {
      // O link mora na raiz de perfis e aponta para um sentinel fora dela.
      const setup = await docker([
        "run",
        "--rm",
        "-v",
        `${volume}:/profiles`,
        "-v",
        `${boxVolume}:/elsewhere`,
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        "set -eu; printf fora > /elsewhere/outside.txt; chown 0:0 /elsewhere/outside.txt; ln -sf /elsewhere/outside.txt /profiles/link-fora; readlink /profiles/link-fora",
      ]);
      requireDocker(setup, "plantar o symlink externo", ["run"]);
      const init = await asRoot("sh /etc/s6-overlay/scripts/profiles-init.sh");
      requireDocker(init, "rodar o inicializador com o symlink", ["run"]);
      const check = await docker([
        "run",
        "--rm",
        "-v",
        `${volume}:/profiles`,
        "-v",
        `${boxVolume}:/elsewhere`,
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        "stat -c '%u:%g %n' /elsewhere/outside.txt; cat /elsewhere/outside.txt; readlink /profiles/link-fora; rm -f /profiles/link-fora",
      ]);
      requireDocker(check, "conferir o alvo externo", ["run"]);
      expect(check.stdout).toContain("0:0 /elsewhere/outside.txt");
      expect(check.stdout).toContain("fora");
      expect(check.stdout).toContain("/elsewhere/outside.txt");
    },
    { timeout: 120_000 },
  );

  test(
    "montagem somente leitura falha explicitamente e não apaga dados",
    async () => {
      const result = await docker([
        "run",
        "--rm",
        "-v",
        `${volume}:/profiles:ro`,
        "--user",
        "0:0",
        "--entrypoint",
        "sh",
        IMAGE,
        "-c",
        "sh /etc/s6-overlay/scripts/profiles-init.sh",
      ]);
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("profiles-init:");
      const intact = await asRoot(
        "cat /profiles/sentinel.txt; cat /profiles/risk-analyst/Cookies; ls /profiles",
      );
      requireDocker(intact, "conferir dados intactos após o mount ro", ["run"]);
      expect(intact.stdout).toContain("sentinel");
      expect(intact.stdout).toContain("cookies");
    },
    { timeout: 120_000 },
  );
});

describe.skipIf(!asked)(
  "o computador de verdade sobre o volume corrigido",
  () => {
    test(
      "sobe, e o health diz 200 com storage pronto",
      async () => {
        await runComputer();
        const base = await containerBase();
        await healthOk(base);
        const health = await computer(base, TOKEN, BOT).health();
        expect(health.status).toBe(200);
      },
      { timeout: 120_000 },
    );

    test(
      "health diz 503 quando a raiz perde escrita, e 200 quando ela volta",
      async () => {
        const base = await containerBase();
        const lock = await docker([
          "exec",
          "--user",
          "0:0",
          container,
          "chmod",
          "555",
          "/profiles",
        ]);
        requireDocker(lock, "tirar a escrita da raiz", ["exec"]);
        const down = await computer(base, TOKEN, BOT).health();
        expect(down.status).toBe(503);
        const locked = (await down.json()) as {
          profileStorageReady?: boolean;
          status?: string;
        };
        expect(locked.profileStorageReady).toBe(false);
        expect(locked.status).toBe("error");
        const unlock = await docker([
          "exec",
          "--user",
          "0:0",
          container,
          "chmod",
          "755",
          "/profiles",
        ]);
        requireDocker(unlock, "devolver a escrita da raiz", ["exec"]);
        await healthOk(base);
        const back = await computer(base, TOKEN, BOT).health();
        expect(back.status).toBe(200);
      },
      { timeout: 120_000 },
    );

    test(
      "navega na fixture, o título e o token chegam, e os frames mudam com a página",
      async () => {
        const base = await containerBase();
        const api = computer(base, TOKEN, BOT);
        const fixture = `http://host.docker.internal:${fixturePort}/`;
        const navigated = await api.call("/navigate", { url: fixture });
        expect(navigated.status).toBe(200);
        const page = navigated.payload as { title?: string; text?: string };
        expect(page.title).toBe(FIXTURE_TITLE);

        const shot = await api.get("/screenshot");
        expect(shot.status).toBe(200);
        const image = shot.payload as { base64?: string };
        expect(typeof image.base64).toBe("string");
        expect((image.base64 as string).length).toBeGreaterThan(1000);

        const watcher = watchStream(base, BOT, TOKEN);
        try {
          const before = await watcher.frames(1);
          expect(before.width).toBeGreaterThan(0);
          const bytes = Buffer.from(before.data, "base64");
          const info = jpegInfo(bytes);
          expect(info.width).toBe(before.width);
          expect(info.height).toBe(before.height);

          // A página muda de verdade: navegar para outro endpoint gera pixels novos.
          // (POST direto no servidor não toca o DOM; screencast só emite frame quando a página muda.)
          const mark = watcher.count;
          const moved = await api.call("/navigate", { url: `${fixture}cookies` });
          expect(moved.status).toBe(200);
          const after = await watcher.frames(mark + 1);
          expect(after.data).not.toBe(before.data);
          const afterInfo = jpegInfo(Buffer.from(after.data, "base64"));
          expect(afterInfo.width).toBeGreaterThan(0);
        } finally {
          watcher.close();
        }
      },
      { timeout: 180_000 },
    );

    test(
      "assistir não é dirigir: input sem controle é recusado, com controle muda a página",
      async () => {
        const base = await containerBase();
        const api = computer(base, TOKEN, BOT);
        const fixture = `http://host.docker.internal:${fixturePort}/`;
        const placed = await api.call("/navigate", { url: fixture });
        expect(placed.status).toBe(200);
        const readState = async (): Promise<{ mutated: boolean }> =>
          (await (
            await fetch(`http://127.0.0.1:${fixturePort}/state`)
          ).json()) as {
            mutated: boolean;
          };

        const refused = await api.call("/human/click", { x: 100, y: 100 });
        expect(refused.status).toBe(409);
        expect((refused.payload as { error?: string }).error ?? "").not.toBe(
          "",
        );
        expect((await readState()).mutated).toBe(false);

        const taken = await api.call("/control/take");
        expect(taken.status).toBe(200);

        const clicked = await api.call("/human/click", { x: 100, y: 100 });
        expect(clicked.status).toBe(200);
        const deadline = Date.now() + 30_000;
        for (;;) {
          if ((await readState()).mutated) break;
          if (Date.now() > deadline)
            throw new Error("o clique com controle não chegou à fixture");
          await sleep(300);
        }

        const released = await api.call("/control/release");
        expect(released.status).toBe(200);
        const refusedAgain = await api.call("/human/click", { x: 100, y: 100 });
        expect(refusedAgain.status).toBe(409);
      },
      { timeout: 180_000 },
    );

    test(
      "o viewer novo sobrevive ao fechamento do antigo",
      async () => {
        const base = await containerBase();
        const api = computer(base, TOKEN, BOT);
        const before = watchStream(base, BOT, TOKEN);
        try {
          await before.frames(1);
          const next = watchStream(base, BOT, TOKEN);
          try {
            await next.frames(1);
            before.close();
            const mark = next.count;
            const moved = await api.call("/navigate", {
              url: `http://host.docker.internal:${fixturePort}/cookies`,
            });
            expect(moved.status).toBe(200);
            const newer = await next.frames(mark + 1);
            const info = jpegInfo(Buffer.from(newer.data, "base64"));
            expect(info.width).toBeGreaterThan(0);
          } finally {
            next.close();
          }
        } finally {
          before.close();
        }
      },
      { timeout: 180_000 },
    );

    test(
      "o cookie sintético atravessa a recriação do container",
      async () => {
        const base = await containerBase();
        const api = computer(base, TOKEN, BOT);
        const fixture = `http://host.docker.internal:${fixturePort}/`;
        const visited = await api.call("/navigate", { url: fixture });
        expect(visited.status).toBe(200);

        // O Chromium grava o perfil antes de sair; sem isso, o cookie da última hora se perde.
        const stopped = await api.call("/computers/stop");
        expect(stopped.status).toBe(200);

        await stopComputer();
        await runComputer();
        const fresh = await containerBase();
        await healthOk(fresh);
        const reopened = await computer(fresh, TOKEN, BOT).call("/navigate", {
          url: `${fixture}cookies`,
        });
        expect(reopened.status).toBe(200);
        const echoed = reopened.payload as { text?: string };
        expect(echoed.text ?? "").toContain(SESSION_COOKIE);
      },
      { timeout: 180_000 },
    );
  },
);
