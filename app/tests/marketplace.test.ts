import { readFile } from "node:fs/promises";
import { describe, expect, test } from "bun:test";
import { BOT_TEMPLATES } from "@/components/marketplace/bot-templates";

describe("bot templates", () => {
  test("covers the 8 component-map responsibilities", () => {
    expect(BOT_TEMPLATES).toHaveLength(8);
    for (const template of BOT_TEMPLATES) {
      expect(template.name.length).toBeGreaterThan(0);
      expect(template.title.length).toBeGreaterThan(0);
      expect(template.description.length).toBeGreaterThan(0);
    }
  });
});

describe("marketplace page", () => {
  test("declares Plugins, Bots and Skills W3 tabs with search", async () => {
    const source = await readFile(
      "app/src/routes/_authed/_app/marketplace.tsx",
      "utf8",
    );
    expect(source).toMatch(/Plugins/);
    expect(source).toMatch(/Bots/);
    expect(source).toMatch(/Skills W3/);
    expect(source).toMatch(/Buscar/);
  });
});
