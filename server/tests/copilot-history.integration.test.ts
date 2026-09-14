import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type { AgentActor } from "../src/agents/profile-types";
import { createAgentProfileStore } from "../src/agents/profile-store";
import { createApp } from "../src/app";
import { createChannelStore } from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { loadConfig } from "../src/config";
import { DurableAgentRunner } from "../src/copilot-runner";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  localThreadHistory,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";
import { testEnvironment } from "./support/environment";

/**
 * Durable history over HTTP, against a disposable database.
 *
 * Fixtures carry their own UUIDs and cleanup deletes only those rows. What is
 * asserted: a thread the boot preload never saw still reads back on demand,
 * in canonical AG-UI shape; anonymous callers get 401, strangers 404, owners
 * 200; legacy rows without a provable owner stay stored but unreadable; and
 * an unreachable database answers 503 rather than a lying empty 200.
 */

const config = loadConfig({ ...testEnvironment() });

/*
 * Pinned to the test database, never process.env: Bun auto-loads .env, whose DATABASE_URL points
 * at the compose-mapped 5433, while the whole test stack (preload, testEnvironment) targets the
 * 5432 below. Reading process.env here means the file passes only with a shell override.
 */
const databaseUrl =
 testEnvironment().DATABASE_URL ??
 "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const channelStore = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("history-test"),
);
const runner = new DurableAgentRunner(database);

const prefix = `copilot-history-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];
const createdThreads: string[] = [];

afterEach(async () => {
  for (const threadId of createdThreads.splice(0)) {
    await database
      .delete(localThreadHistory)
      .where(eq(localThreadHistory.threadId, threadId));
  }
  for (const channelId of createdChannelIds.splice(0)) {
    await database
      .delete(intelligenceChannelMappings)
      .where(eq(intelligenceChannelMappings.channelId, channelId));
    await database.delete(channels).where(eq(channels.id, channelId));
  }
  for (const agentId of createdAgentIds.splice(0)) {
    await database
      .delete(agentProfiles)
      .where(eq(agentProfiles.agentId, agentId));
    await database.delete(agents).where(eq(agents.id, agentId));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

function authenticatedAs(userId: string) {
  return {
    handler: () => new Response(null, { status: 204 }),
    api: {
      getSession: async () => ({
        user: { id: userId, email: `${userId}@example.test` },
      }),
    },
  };
}

const noSessionAuth = {
  handler: () => new Response(null, { status: 204 }),
  api: { getSession: async () => null },
};

const roles = { rolesForUser: async () => ["user"] as ("user" | "admin")[] };

function appFor(
  auth: ReturnType<typeof authenticatedAs> | typeof noSessionAuth,
  historyRunner: DurableAgentRunner = runner,
) {
  return createApp(
    config,
    auth,
    roles,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    profileStore,
    channelStore,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    database,
    historyRunner,
  );
}

async function createUser(): Promise<AgentActor> {
  const userId = `${prefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id: userId,
    email: `${userId}@example.test`,
    name: "History Test User",
  });
  createdUserIds.push(userId);
  return { id: userId, role: "user" };
}

async function createAgent(owner: AgentActor): Promise<string> {
  const agentId = `${prefix}-agent-${randomUUID()}`;
  await database.insert(agents).values({
    id: agentId,
    name: "History Bot",
    type: "remote_ag_ui",
    configuration: { endpoint: "https://agent.example.test/ag-ui" },
  });
  createdAgentIds.push(agentId);
  await database.insert(agentProfiles).values({
    agentId,
    ownerUserId: owner.id,
    title: "History Bot",
    roleDescription: "Reads history.",
    avatarSeed: agentId,
    visibility: "private",
  });
  return agentId;
}

describe("reading durable thread history", () => {
  test("the owner reads a thread the preload never saw, canonically", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const created = await channelStore.create(owner, [agentId]);
    createdChannelIds.push(created.id);
    const threadId = created.threadId;
    createdThreads.push(threadId);
    await database.insert(localThreadHistory).values({
      threadId,
      agentId,
      userId: owner.id,
      messages: {
        messages: [
          { id: "u1", role: "user", content: "run it" },
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
        ],
      },
    });

    // A runner that never preloaded: the on-demand path, not the warm cache.
    const cold = new DurableAgentRunner(database);
    const app = appFor(authenticatedAs(owner.id), cold);
    const response = await app.request(
      `http://openbot.local/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages?agentId=${agentId}`,
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { messages: unknown[] };
    expect(body.messages).toHaveLength(3);
    expect(JSON.stringify(body.messages)).toContain("codex_command");
  });

  test("anonymous callers get 401 and strangers get 404", async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const agentId = await createAgent(owner);
    const created = await channelStore.create(owner, [agentId]);
    createdChannelIds.push(created.id);
    createdThreads.push(created.threadId);

    const anon = await appFor(noSessionAuth).request(
      `http://openbot.local/api/copilotkit/threads/${encodeURIComponent(created.threadId)}/messages`,
    );
    expect(anon.status).toBe(401);

    const foreign = await appFor(authenticatedAs(stranger.id)).request(
      `http://openbot.local/api/copilotkit/threads/${encodeURIComponent(created.threadId)}/messages?agentId=${agentId}`,
    );
    expect(foreign.status).toBe(404);
  });

  test("a legacy row without an owner stays stored but unreadable", async () => {
    const owner = await createUser();
    const threadId = `${prefix}-legacy-${randomUUID()}`;
    createdThreads.push(threadId);
    await database.insert(localThreadHistory).values({
      threadId,
      agentId: "old-bot",
      userId: null,
      messages: { messages: [] },
    });

    const response = await appFor(authenticatedAs(owner.id)).request(
      `http://openbot.local/api/copilotkit/threads/${encodeURIComponent(threadId)}/messages`,
    );
    expect(response.status).toBe(404);

    const rows = await database
      .select({ threadId: localThreadHistory.threadId })
      .from(localThreadHistory)
      .where(eq(localThreadHistory.threadId, threadId));
    expect(rows).toHaveLength(1);
  });

  test("an unreachable database answers 503, never an empty 200", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const created = await channelStore.create(owner, [agentId]);
    createdChannelIds.push(created.id);
    createdThreads.push(created.threadId);

    const broken = createDatabase(
      "postgres://openbot:openbot@localhost:59999/openbot",
      TEST_POOL,
    );
    try {
      const app = appFor(authenticatedAs(owner.id), new DurableAgentRunner(broken));
      const response = await app.request(
        `http://openbot.local/api/copilotkit/threads/${encodeURIComponent(created.threadId)}/messages`,
      );
      expect(response.status).toBe(503);
    } finally {
      await broken.$client.close().catch(() => {});
    }
  });
});
