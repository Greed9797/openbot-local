import { describe, expect, test } from "bun:test";
import { createDatabase } from "../src/db/client";
import { skills } from "../src/db/schema";
import { TEST_POOL } from "./support/database";

const databaseUrl =
  process.env.DATABASE_URL ??
  "postgres://openbot:openbot@localhost:5432/openbot";
const database = createDatabase(databaseUrl, TEST_POOL);

const EXPECTED_SLUGS = [
  "research-prospect",
  "qualify-sales-opportunity",
  "close-customer-loop",
  "monitor-sales-pipeline",
  "prepare-shopify-proposal",
  "manage-shopify-project",
  "audit-shopify-store",
  "validate-shopify-launch",
  "review-design",
  "plan-seo-aeo-content",
  "monitor-competitors",
  "analyze-project-margin",
  "research-product-opportunity",
  "run-executive-review",
];

describe("w3 skill seed", () => {
  test("seeds 14 catalogue skills owned by the deployment", async () => {
    const rows = await database.select().from(skills);
    expect(EXPECTED_SLUGS.length).toBe(14);
    for (const slug of EXPECTED_SLUGS) {
      const row = rows.find((candidate) => candidate.slug === slug);
      expect(row).toBeDefined();
      expect(row?.origin).toBe("catalogue");
      expect(row?.ownerUserId).toBeNull();
      expect(row?.instructions.length).toBeGreaterThan(100);
    }
  });
});
