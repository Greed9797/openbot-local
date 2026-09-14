import { describe, expect, test } from "bun:test";
import type { AuditEventInput, AuditStore } from "../src/audit";
import { createComputerGateway } from "../src/computer/gateway";
import { StaleSnapshotError } from "../src/computer/client";
import type { ActionPolicy } from "../src/computer/policy";
import type { ComputerProvider } from "../src/computer/provider";
import type { SnapshotResult } from "../src/computer/schema";

/**
 * One action across a re-render.
 *
 * A collection that never stops moving kills refs between the snapshot and the action. The gateway
 * re-resolves once by role and accessible name — and only then. These tests pin the three outcomes
 * that matter: a unique match acts exactly once more, ambiguity keeps the original refusal, and a
 * non-stale failure never triggers a second attempt.
 */

const SHOP_URL = "https://shop.test/collection";

const oldSnapshot = (id: number, buyRefs: string[]): SnapshotResult => ({
  snapshotId: id,
  url: SHOP_URL,
  title: "Collection",
  truncated: false,
  viewport: { width: 1280, height: 800 },
  elements: [
    ...buyRefs.map((ref) => ({ ref, role: "button", name: "Buy now" })),
    { ref: "ex", role: "button", name: "Cancel" },
  ],
});

const ACTOR = { id: "dev-local-user" };
const PERMISSIVE: ActionPolicy = { mode: "enforce", deny: [], allow: ["true"] };

function setup(options: {
  freshBuyRefs: string[];
  clickStatuses: number[];
}) {
  const clickBodies: unknown[] = [];
  let clicks = 0;
  let snapshots = 0;
  const rows: AuditEventInput[] = [];
  const provider: ComputerProvider = {
    name: "test",
    isolation: "per-bot",
    locate: async () => "http://agent-computer:4100",
    status: async (botId) => ({ botId, state: "ready" }),
    stop: async () => ({ wasRunning: true }),
    reset: async () => ({ cleared: true }),
    list: async () => [],
  };
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === "/snapshot") {
      snapshots += 1;
      return Response.json(
        snapshots === 1 ? oldSnapshot(7, ["e9"]) : oldSnapshot(8, options.freshBuyRefs),
      );
    }
    if (path === "/click") {
      clicks += 1;
      clickBodies.push(JSON.parse(String(init?.body)));
      const status = options.clickStatuses[Math.min(clicks - 1, options.clickStatuses.length - 1)];
      if (status !== 200) return Response.json({ error: "went stale" }, { status });
      return Response.json({ action: "click", url: SHOP_URL });
    }
    return Response.json({ error: `Unknown endpoint: ${path}` }, { status: 404 });
  }) as unknown as typeof fetch;
  const store: AuditStore = { insert: async (event) => void rows.push(event) };
  const gateway = createComputerGateway({
    provider,
    fetchImpl,
    auditStore: store,
    policy: () => PERMISSIVE,
  });
  return { gateway, rows, clickBodies, count: () => ({ clicks, snapshots }) };
}

describe("acting across a re-render", () => {
  test("a unique match acts once more with the new ref", async () => {
    const { gateway, rows, clickBodies, count } = setup({
      freshBuyRefs: ["e3"],
      clickStatuses: [409, 200],
    });
    await gateway.snapshot("bot-1");

    const result = await gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 });

    expect(count().clicks).toBe(2);
    expect(clickBodies[1]).toMatchObject({ ref: "e3", snapshotId: 8 });
    expect(result).toMatchObject({ action: "click" });
    // Three rows: tried, went stale, ran with the new ref. The failure row is the design —
    // a trail that only contains successes cannot show what the retry recovered from.
    expect(rows.map((row) => row.eventType)).toEqual([
      "computer.action_allowed",
      "computer.action_failed",
      "computer.action_allowed",
    ]);
  });

  test("two matches keep the original refusal and never act twice", async () => {
    const { gateway, count } = setup({
      freshBuyRefs: ["e3", "e4"],
      clickStatuses: [409, 200],
    });
    await gateway.snapshot("bot-1");

    await expect(
      gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toBeInstanceOf(StaleSnapshotError);
    expect(count().clicks).toBe(1);
  });

  test("a non-stale failure never triggers a second attempt", async () => {
    const { gateway, count } = setup({
      freshBuyRefs: ["e3"],
      clickStatuses: [500],
    });
    await gateway.snapshot("bot-1");

    await expect(
      gateway.click("bot-1", ACTOR, { ref: "e9", snapshotId: 7 }),
    ).rejects.toThrow();
    expect(count().clicks).toBe(1);
  });
});
