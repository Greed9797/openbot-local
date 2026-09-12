import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createAuditStore } from "../src/audit";
import { createDatabase } from "../src/db/client";
import { agentProfiles, agents, pluginGrants, skills, users } from "../src/db/schema";
import { createPluginStore } from "../src/plugins/store";
import { TEST_POOL } from "./support/database";

/**
 * The marketplace Bot-install round trip: granting a W3 catalogue skill to a
 * freshly created Bot makes it visible via what that Bot holds.
 */

const database = createDatabase(
  process.env.DATABASE_URL ??
    "postgres://openbot:openbot@localhost:5432/openbot",
  TEST_POOL,
);

const store = createPluginStore({
  database,
  auditStore: createAuditStore(database),
  credentials: { readSecret: async () => null },
  encryptionKey: "x".repeat(44),
  policy: () => ({ mode: "enforce", deny: [], allow: ["true"] }),
});

const suite = randomUUID().slice(0, 8);
const owner = `user_market_${suite}`;
const bot = `agent_market_${suite}`;
const slug = `market-skill-${suite}`;

afterEach(async () => {
  await database.delete(pluginGrants).where(eq(pluginGrants.agentId, bot));
  await database.delete(skills).where(eq(skills.slug, slug));
  await database.delete(agentProfiles).where(eq(agentProfiles.agentId, bot));
  await database.delete(agents).where(eq(agents.id, bot));
  await database.delete(users).where(eq(users.id, owner));
});

describe("marketplace bot install", () => {
  test("grants a catalogue skill to a new bot and reads it back", async () => {
    await database
      .insert(users)
      .values({ id: owner, email: `${owner}@example.test`, name: owner });
    await database
      .insert(agents)
      .values({ id: bot, name: bot, type: "remote_ag_ui", configuration: {} });
    await database.insert(agentProfiles).values({
      agentId: bot,
      ownerUserId: owner,
      title: bot,
      roleDescription: bot,
      avatarSeed: bot,
      visibility: "private",
    });
    await database.insert(skills).values({
      id: randomUUID(),
      slug,
      title: "Market skill",
      summary: "A skill installed from the marketplace.",
      instructions: "Do the market thing.",
      origin: "catalogue",
    });

    await store.grant("skill", slug, bot, owner);

    const held = await store.listForAgent(bot);
    expect(held.skills.map((skill) => skill.slug)).toContain(slug);
  });
});
