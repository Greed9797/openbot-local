import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createDatabase } from "../src/db/client";
import { emailAuthGate } from "../src/auth/email-gate";
import { checkRateLimit } from "../src/auth/rate-limit";
import { inviteEnrollment } from "../src/people/enrollments";
import { seedSectors } from "../src/sectors/store";
import { sectorEnrollments } from "../src/db/schema";
import { eq } from "drizzle-orm";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const prefix = `email-gate-${randomUUID()}`;

afterAll(async () => {
  await database
    .delete(sectorEnrollments)
    .where(eq(sectorEnrollments.email, `${prefix}@example.test`));
  await database.$client.close();
});

function gateContext(path: string, method: string, body?: unknown) {
  const headers = new Headers();
  if (body !== undefined) headers.set("content-type", "application/json");
  return {
    req: {
      url: `http://openbot.test${path}`,
      method,
      header: (name: string) =>
        name.toLowerCase() === "x-forwarded-for" ? `${prefix}-ip` : null,
      json: async () => body ?? null,
      raw: new Request(`http://openbot.test${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      }),
    },
    json: (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status }),
  } as unknown as Parameters<typeof emailAuthGate>[1];
}

describe("email auth gate", () => {
  test("signup without invitation is refused", async () => {
    const res = await emailAuthGate(
      database,
      gateContext("/api/auth/sign-up/email", "POST", {
        email: `${prefix}-stranger@example.test`,
        password: "a-very-long-password-1",
        name: "Stranger",
      }),
    );
    expect(res?.status).toBe(403);
  });

  test("signup with a valid invitation passes to Better Auth", async () => {
    await seedSectors(database);
    await inviteEnrollment(database, {
      email: `${prefix}@example.test`,
      name: "Invited",
      sectorId: "websites",
      role: "user",
    });
    const res = await emailAuthGate(
      database,
      gateContext("/api/auth/sign-up/email", "POST", {
        email: `${prefix}@example.test`,
        password: "a-very-long-password-1",
        name: "Invited",
      }),
    );
    expect(res).toBeUndefined();
  });

  test("sixth sign-in attempt in a minute is refused", async () => {
    for (let i = 0; i < 5; i++) {
      await emailAuthGate(
        database,
        gateContext("/api/auth/sign-in/email", "POST", {
          email: `someone${i}@example.test`,
          password: "a-very-long-password-1",
        }),
      );
    }
    const res = await emailAuthGate(
      database,
      gateContext("/api/auth/sign-in/email", "POST", {
        email: "someone5@example.test",
        password: "a-very-long-password-1",
      }),
    );
    expect(res?.status).toBe(429);
  });

  test("rate limit window resets", async () => {
    const key = `test-window-${prefix}`;
    expect(await checkRateLimit(database, key, 2, 60_000)).toBe(true);
    expect(await checkRateLimit(database, key, 2, 60_000)).toBe(true);
    expect(await checkRateLimit(database, key, 2, 60_000)).toBe(false);
    expect(await checkRateLimit(database, key, 2, 0)).toBe(true);
  });
});
