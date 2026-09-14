import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { agents, sectorBots, sectors } from "../db/schema";

export const SECTOR_IDS = [
  "w3-vendas",
  "customer-success",
  "marketplace",
  "websites",
  "trafego-pago",
  "livelab",
] as const;

export const SECTOR_NAMES: Record<string, string> = {
  "w3-vendas": "W3 Vendas",
  "customer-success": "Customer Success",
  marketplace: "Agência Marketplace",
  websites: "Websites",
  "trafego-pago": "Agência de Tráfego Pago",
  livelab: "LiveLab",
};

export type SectorRow = typeof sectors.$inferSelect;
export type SectorBotRow = typeof sectorBots.$inferSelect;

export type SectorStore = {
  list(): Promise<SectorRow[]>;
  sectorForBot(botId: string): Promise<string | null>;
  sectorIdForOwner(ownerId: string): Promise<string | null>;
  registerBot(botId: string, sectorId: string): Promise<void>;
  botsOf(sectorId: string): Promise<SectorBotRow[]>;
  updateBot(botId: string, patch: { accountLabel?: string | null; sellerUrl?: string | null; enabled?: boolean }): Promise<SectorBotRow | null>;
};

export function createSectorStore(database: Database): SectorStore {
  return {
    async list() {
      return database.select().from(sectors);
    },
    async sectorForBot(botId: string) {
      const [row] = await database.select({ sectorId: sectorBots.sectorId }).from(sectorBots).where(eq(sectorBots.botId, botId)).limit(1);
      return row?.sectorId ?? null;
    },
    async sectorIdForOwner(ownerId: string) {
      const [row] = await database.select({ id: sectors.id }).from(sectors).where(eq(sectors.ownerUserId, ownerId)).limit(1);
      return row?.id ?? null;
    },
    async registerBot(botId: string, sectorId: string) {
      await database.insert(sectorBots).values({ botId, sectorId, enabled: false }).onConflictDoNothing({ target: sectorBots.botId });
    },
    async botsOf(sectorId: string) {
      return database.select().from(sectorBots).where(eq(sectorBots.sectorId, sectorId));
    },
    async updateBot(botId, patch) {
      const set: Partial<typeof sectorBots.$inferInsert> = {};
      if (patch.accountLabel !== undefined)
        set.accountLabel = patch.accountLabel;
      if (patch.sellerUrl !== undefined) set.sellerUrl = patch.sellerUrl;
      if (patch.enabled !== undefined) set.enabled = patch.enabled;
      if (Object.keys(set).length === 0) {
        const [row] = await database
          .select()
          .from(sectorBots)
          .where(eq(sectorBots.botId, botId))
          .limit(1);
        return row ?? null;
      }
      await database
        .update(sectorBots)
        .set(set)
        .where(eq(sectorBots.botId, botId));
      const [row] = await database
        .select()
        .from(sectorBots)
        .where(eq(sectorBots.botId, botId))
        .limit(1);
      return row ?? null;
    },
  };
}

export async function seedSectors(database: Database): Promise<void> {
  for (const id of SECTOR_IDS) {
    await database
      .insert(sectors)
      .values({ id, name: SECTOR_NAMES[id] ?? id })
      .onConflictDoNothing({ target: sectors.id });
  }
}

export async function assertBotUsable(
  database: Database,
  botId: string,
): Promise<boolean> {
  const [row] = await database.select({ enabled: sectorBots.enabled }).from(sectorBots).innerJoin(agents, eq(agents.id, sectorBots.botId)).where(eq(sectorBots.botId, botId)).limit(1);
  if (!row) return true;
  return row.enabled;
}
