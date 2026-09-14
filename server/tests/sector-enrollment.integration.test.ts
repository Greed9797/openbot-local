import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { createDatabase } from "../src/db/client";
import {
  agents,
  sectorBots,
  sectorEnrollments,
  sectors,
  users,
} from "../src/db/schema";
import {
  acceptEnrollment,
  inviteEnrollment,
  resendEnrollment,
} from "../src/people/enrollments";
import { createSectorStore, seedSectors } from "../src/sectors/store";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);
const prefix = `sector-enroll-${randomUUID()}`;
const createdEmails: string[] = [];
const createdUserIds: string[] = [];
const createdBotIds: string[] = [];

afterEach(async () => {
  for (const botId of createdBotIds.splice(0)) {
    await database.delete(sectorBots).where(eq(sectorBots.botId, botId));
    await database.delete(agents).where(eq(agents.id, botId));
  }
  for (const email of createdEmails.splice(0)) {
    await database.delete(sectorEnrollments).where(eq(sectorEnrollments.email, email));
  }
  for (const userId of createdUserIds.splice(0)) {
    await database.delete(users).where(eq(users.id, userId));
  }
});

afterAll(async () => {
  await database.$client.close();
});

describe("sector enrollment", () => {
  test("seeds six sectors idempotently", async () => {
    await seedSectors(database);
    await seedSectors(database);
    const store = createSectorStore(database);
    const rows = await store.list();
    const ids = rows.map((r) => r.id).sort();
    expect(ids).toEqual(
      [
        "customer-success",
        "livelab",
        "marketplace",
        "trafego-pago",
        "w3-vendas",
        "websites",
      ].sort(),
    );
  });

  test("invites once per sector and rejects second owner", async () => {
    await seedSectors(database);
    const email = `${prefix}-a@example.test`;
    createdEmails.push(email);
    const row = await inviteEnrollment(database, {
      email,
      name: "Vendas Owner",
      sectorId: "w3-vendas",
      role: "user",
    });
    expect(row.sectorId).toBe("w3-vendas");
    const other = `${prefix}-b@example.test`;
    createdEmails.push(other);
    await expect(
      inviteEnrollment(database, {
        email: other,
        name: "Second",
        sectorId: "w3-vendas",
        role: "user",
      }),
    ).rejects.toThrow();
  });

  test("accept links owner and role on verified email", async () => {
    await seedSectors(database);
    const email = `${prefix}-c@example.test`;
    createdEmails.push(email);
    await inviteEnrollment(database, {
      email,
      name: "CS Owner",
      sectorId: "customer-success",
      role: "user",
    });
    const userId = `${prefix}-user-c`;
    createdUserIds.push(userId);
    await database.insert(users).values({
      id: userId,
      email,
      name: "CS Owner",
      emailVerified: true,
    });
    await acceptEnrollment(database, email, userId);
    const [sector] = await database
      .select()
      .from(sectors)
      .where(eq(sectors.id, "customer-success"));
    expect(sector?.ownerUserId).toBe(userId);
  });

  test("resend renews expiry for pending invite", async () => {
    await seedSectors(database);
    const email = `${prefix}-d@example.test`;
    createdEmails.push(email);
    await inviteEnrollment(database, {
      email,
      name: "Market Owner",
      sectorId: "marketplace",
      role: "user",
    });
    const renewed = await resendEnrollment(database, email);
    expect(renewed.expiresAt?.getTime() ?? 0).toBeGreaterThan(Date.now());
  });

  test("sector bots start disabled by schema default", async () => {
    await seedSectors(database);
    const botId = `${prefix}-bot-${randomUUID()}`;
    createdBotIds.push(botId);
    await database.insert(agents).values({
      id: botId,
      name: `${prefix}-bot`,
      type: "remote_ag_ui",
      configuration: {},
    });
    await database.insert(sectorBots).values({ botId, sectorId: "websites" });
    const [row] = await database.select().from(sectorBots).where(eq(sectorBots.botId, botId));
    expect(row?.enabled).toBe(false);
    const store = createSectorStore(database);
    expect(await store.sectorForBot(botId)).toBe("websites");
  });
});
