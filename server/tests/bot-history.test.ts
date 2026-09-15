import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import { Hono } from "hono";
import { createAgentProfileStore } from "../src/agents/profile-store";
import type { AgentActor } from "../src/agents/profile-types";
import type { AppVariables } from "../src/auth/guards";
import { createBotHistoryRoutes } from "../src/channels/bot-history-routes";
import {
  type ChannelStore,
  createChannelRoutes,
  createChannelStore,
} from "../src/channels/routes";
import { createThreadIdentity } from "../src/channels/thread-identity";
import { createDatabase } from "../src/db/client";
import {
  agentProfiles,
  agents,
  channels,
  intelligenceChannelMappings,
  users,
} from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const profileStore = createAgentProfileStore(
  database,
  new URL("https://managed.example.test/ag-ui"),
);
const store = createChannelStore(
  database,
  profileStore,
  createThreadIdentity("test-deployment"),
);

/**
 * Mesmo relógio nos dois lados da ordenação — ver `databaseNow` em
 * channel-activity.integration.test.ts. A regra sob teste é a ordem, não o
 * skew entre o container e este processo.
 */
async function databaseNow(): Promise<Date> {
  const [row] = (await database.execute(
    sql`select now() as at`,
  )) as unknown as { at: Date | string }[];
  return new Date(row?.at ?? Date.now());
}

const testPrefix = `bot-history-${randomUUID()}`;
const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdChannelIds: string[] = [];

afterEach(async () => {
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

async function createUser(): Promise<AgentActor> {
  const id = `${testPrefix}-user-${randomUUID()}`;
  await database.insert(users).values({
    id,
    email: `${id}@example.test`,
    name: "Bot History Test User",
  });
  createdUserIds.push(id);
  return { id, role: "user" };
}

async function createAgent(
  owner: AgentActor,
  name = "History Bot",
  visibility: "public" | "private" = "private",
) {
  const profile = await profileStore.create(owner, {
    name,
    title: "History",
    roleDescription: "Keeps conversations.",
    visibility,
  });
  createdAgentIds.push(profile.id);
  return profile.id;
}

async function hiddenChannel(
  owner: AgentActor,
  agentId: string,
  saidAt?: Date,
  text = "Something was said.",
) {
  const channel = await store.create(owner, [agentId], {
    visivelNoRoster: false,
  });
  createdChannelIds.push(channel.id);
  if (saidAt) {
    await store.recordActivity(owner, channel.id, {
      agentId,
      at: saidAt,
      text,
    });
  }
  return channel;
}

function middlewareFor(user: AgentActor) {
  const middleware: MiddlewareHandler<{ Variables: AppVariables }> = async (
    context,
    next,
  ) => {
    context.set("actor", user);
    await next();
  };
  return middleware;
}

function historyApp(channelStore: ChannelStore, user: AgentActor) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.route("/ch", createChannelRoutes(channelStore, middlewareFor(user)));
  app.route(
    "/bots",
    createBotHistoryRoutes(channelStore, profileStore, middlewareFor(user)),
  );
  return app;
}

async function historyJson(
  app: ReturnType<typeof historyApp>,
  botId: string,
  query = "",
) {
  const response = await app.request(
    `http://openbot.test/bots/${botId}/conversas${query}`,
  );
  return { status: response.status, body: await response.json() };
}

describe("bot history visibility split", () => {
  test("hidden conversations leave the roster and list per bot", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const hidden = await hiddenChannel(owner, agentId);

    expect(await store.list(owner)).toEqual([]);

    const page = await store.listBotConversations(owner, agentId, {});
    expect(page.items.map((item) => item.id)).toEqual([hidden.id]);
    expect(page.nextCursor).toBeUndefined();
  });

  test("visible channels with the bot stay out of history", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const visible = await store.create(owner, [agentId]);
    createdChannelIds.push(visible.id);
    await hiddenChannel(owner, agentId);

    const page = await store.listBotConversations(owner, agentId, {});
    expect(page.items.map((item) => item.id)).toHaveLength(1);
    expect((await store.list(owner)).map((channel) => channel.id)).toContain(
      visible.id,
    );
  });

  test("create defaults to visible", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const created = await store.create(owner, [agentId]);
    createdChannelIds.push(created.id);

    expect((await store.list(owner)).map((channel) => channel.id)).toContain(
      created.id,
    );
  });

  test("POST visivelNoRoster:false hides the channel from GET /api/channels", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const app = historyApp(store, owner);

    const created = await app.request("http://openbot.test/ch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [agentId], visivelNoRoster: false }),
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { channel: { id: string } };
    createdChannelIds.push(createdBody.channel.id);

    const roster = await app.request("http://openbot.test/ch");
    expect(await roster.json()).toEqual({ channels: [] });

    const { status, body } = await historyJson(app, agentId);
    expect(status).toBe(200);
    expect(
      (body as { conversas: { id: string }[] }).conversas.map((c) => c.id),
    ).toEqual([createdBody.channel.id]);
  });

  test("POST rejects a non-boolean visibility", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const app = historyApp(store, owner);

    const response = await app.request("http://openbot.test/ch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentIds: [agentId], visivelNoRoster: "yes" }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Visibility must be a boolean.",
    });
  });
});

describe("bot history search", () => {
  test("finds by channel name", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Fatura mensal");
    const base = await databaseNow();
    await hiddenChannel(
      owner,
      agentId,
      new Date(base.getTime() - 60_000),
      "Primeira conversa.",
    );
    const otherAgent = await createAgent(owner, "Outro Bot");
    await hiddenChannel(
      owner,
      otherAgent,
      new Date(base.getTime() - 30_000),
      "Segunda conversa.",
    );

    const page = await store.listBotConversations(owner, agentId, {
      q: "fatura",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.name).toContain("Fatura mensal");
  });

  test("finds by last message preview", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const base = await databaseNow();
    await hiddenChannel(
      owner,
      agentId,
      new Date(base.getTime() - 60_000),
      "Reembolso aprovado ontem.",
    );
    await hiddenChannel(
      owner,
      agentId,
      new Date(base.getTime() - 30_000),
      "Nada a ver com isso.",
    );

    const page = await store.listBotConversations(owner, agentId, {
      q: "reembolso",
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.lastMessage).toContain("Reembolso");
  });

  test("a term that matches nothing returns nothing", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const base = await databaseNow();
    await hiddenChannel(
      owner,
      agentId,
      new Date(base.getTime() - 60_000),
      "Conversa sobre relatórios.",
    );

    const page = await store.listBotConversations(owner, agentId, {
      q: "zxqwxy-nunca-existe",
    });
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeUndefined();
  });
});

describe("bot history cursor", () => {
  async function threeConversations(owner: AgentActor, agentId: string) {
    const base = await databaseNow();
    const oldest = await hiddenChannel(
      owner,
      agentId,
      new Date(base.getTime() - 180_000),
      "Mais antiga.",
    );
    const middle = await hiddenChannel(
      owner,
      agentId,
      new Date(base.getTime() - 120_000),
      "Do meio.",
    );
    const newest = await hiddenChannel(
      owner,
      agentId,
      new Date(base.getTime() - 60_000),
      "Mais nova.",
    );
    return { oldest, middle, newest };
  }

  test("pages three conversations exactly once when nothing moves", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const { oldest, middle, newest } = await threeConversations(owner, agentId);

    const first = await store.listBotConversations(owner, agentId, {
      limit: 2,
    });
    expect(first.items.map((item) => item.id)).toEqual([newest.id, middle.id]);
    expect(typeof first.nextCursor).toBe("string");

    const second = await store.listBotConversations(owner, agentId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual([oldest.id]);
    expect(second.nextCursor).toBeUndefined();
  });

  test("new activity on the unlisted row admits absence, never duplicates", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const { oldest } = await threeConversations(owner, agentId);

    const first = await store.listBotConversations(owner, agentId, {
      limit: 2,
    });
    const firstIds = first.items.map((item) => item.id);

    await store.recordActivity(owner, oldest.id, {
      agentId,
      at: new Date((await databaseNow()).getTime() + 60_000),
      text: "A mais antiga voltou ao topo.",
    });

    const second = await store.listBotConversations(owner, agentId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    const secondIds = second.items.map((item) => item.id);

    expect(secondIds.filter((id) => firstIds.includes(id))).toEqual([]);
    expect(secondIds).not.toContain(oldest.id);
  });

  test("new activity on a listed row moves it out of the next page", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const { oldest, middle, newest } = await threeConversations(owner, agentId);

    const first = await store.listBotConversations(owner, agentId, {
      limit: 2,
    });
    expect(first.items.map((item) => item.id)).toEqual([newest.id, middle.id]);

    await store.recordActivity(owner, middle.id, {
      agentId,
      at: new Date((await databaseNow()).getTime() + 60_000),
      text: "A do meio voltou ao topo.",
    });

    const second = await store.listBotConversations(owner, agentId, {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.items.map((item) => item.id)).toEqual([oldest.id]);
  });

  test("invalid cursor answers 400 with a dito error", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    const app = historyApp(store, owner);

    const { status, body } = await historyJson(app, agentId, "?cursor=!!!");
    expect(status).toBe(400);
    expect(body).toEqual({ error: "cursor de paginação inválido" });
  });

  test("limit=1 returns one item plus a cursor", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    await threeConversations(owner, agentId);

    const app = historyApp(store, owner);
    const { status, body } = await historyJson(app, agentId, "?limit=1");
    expect(status).toBe(200);
    const parsed = body as { conversas: unknown[]; nextCursor?: string };
    expect(parsed.conversas).toHaveLength(1);
    expect(typeof parsed.nextCursor).toBe("string");
  });
});

describe("bot history access", () => {
  test("non-member and unknown bot share the same 404 shape", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner);
    await hiddenChannel(owner, agentId);
    const stranger = await createUser();

    const strangerApp = historyApp(store, stranger);
    const denied = await historyJson(strangerApp, agentId);
    expect(denied.status).toBe(404);

    const ownerApp = historyApp(store, owner);
    const unknown = await historyJson(ownerApp, "bot-que-nunca-existiu");
    expect(unknown.status).toBe(404);

    expect(denied.body).toEqual(unknown.body);
  });

  test("non-member of a public bot reads an empty list, not a 404", async () => {
    const owner = await createUser();
    const agentId = await createAgent(owner, "Public Bot", "public");
    await hiddenChannel(owner, agentId);
    const stranger = await createUser();

    const { status, body } = await historyJson(
      historyApp(store, stranger),
      agentId,
    );
    expect(status).toBe(200);
    expect(body).toEqual({ conversas: [] });
  });
});
