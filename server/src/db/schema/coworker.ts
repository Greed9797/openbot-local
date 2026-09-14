/**
 * Coworker tables: bots, skills, routines, bot-to-bot handoff.
 *
 * Split by owner so two people can add tables all day without touching the same lines. Add tables
 * here; never edit core.ts or computer.ts to do it.
 */
import {
  boolean,
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { agents, role, users } from "./core";

const createdAt = () =>
  timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

export const agentVisibility = pgEnum("agent_visibility", [
  "public",
  "private",
]);

export const agentProfiles = pgTable(
  "agent_profiles",
  {
    agentId: text("agent_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    title: text("title").notNull(),
    roleDescription: text("role_description").notNull(),
    avatarSeed: text("avatar_seed").notNull(),
    visibility: agentVisibility("visibility").notNull(),
    /*
     * The credential this Bot's agent presents when it calls a tool back.
     *
     * A hash, never the token. We issue it, the agent's owner holds it, and this side only ever needs
     * to check one: storing the token itself would mean a database dump is a set of working
     * credentials for every registered agent.
     *
     * Null means the agent has not been issued one and may not call tools back, which is the right
     * default: a URL somebody pasted gets no capability until an administrator hands it one.
     */
    callbackTokenHash: text("callback_token_hash"),
    callbackTokenIssuedAt: timestamp("callback_token_issued_at", {
      withTimezone: true,
    }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [
    index("agent_profiles_visibility_deleted_idx").on(
      table.visibility,
      table.deletedAt,
    ),
  ],
);

export const agentPreferences = pgTable(
  "agent_preferences",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    agentId: text("agent_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    hiddenAt: timestamp("hidden_at", { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.userId, table.agentId] })],
);

export const sectors = pgTable("sectors", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  ownerUserId: text("owner_user_id")
    .unique()
    .references(() => users.id, { onDelete: "set null" }),
  lastDispatchedAt: timestamp("last_dispatched_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sectorBots = pgTable(
  "sector_bots",
  {
    botId: text("bot_id")
      .primaryKey()
      .references(() => agents.id, { onDelete: "cascade" }),
    sectorId: text("sector_id")
      .notNull()
      .references(() => sectors.id),
    accountLabel: text("account_label"),
    sellerUrl: text("seller_url"),
    accountOrdinal: integer("account_ordinal"),
    enabled: boolean("enabled").notNull().default(false),
  },
  (table) => [
    index("sector_bots_sector_idx").on(table.sectorId),
    uniqueIndex("sector_bots_sector_ordinal_idx").on(
      table.sectorId,
      table.accountOrdinal,
    ),
  ],
);

/**
 * What each sector does on its own, without a person asking.
 *
 * A routine names a Bot of its sector, an objective, and how often it runs. The scheduler lives in
 * the worker's housekeeping tick and enqueues one run per due routine, keyed so a second scheduler
 * — or the same tick running long — cannot enqueue the same slot twice. Interval, not cron: six
 * sectors need "every morning", not a calendar language, and an interval is one integer nobody can
 * miswrite.
 */
export const sectorRoutines = pgTable(
  "sector_routines",
  {
    id: text("id").primaryKey(),
    sectorId: text("sector_id")
      .notNull()
      .references(() => sectors.id, { onDelete: "cascade" }),
    botId: text("bot_id")
      .notNull()
      .references(() => agents.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    objective: text("objective").notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    lastEnqueuedAt: timestamp("last_enqueued_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => [index("sector_routines_sector_idx").on(table.sectorId)],
);

export const sectorEnrollments = pgTable("sector_enrollments", {
  email: text("email").primaryKey(),
  name: text("name").notNull(),
  sectorId: text("sector_id")
    .unique()
    .references(() => sectors.id),
  role: role("role").notNull().default("user"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  acceptedUserId: text("accepted_user_id").references(() => users.id, {
    onDelete: "set null",
  }),
  createdAt: createdAt(),
});
