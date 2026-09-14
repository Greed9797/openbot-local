import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProfiles } from "../src/profiles";

const ENABLED = process.env.VIEWPORT_SMOKE === "1";
const maybe = ENABLED ? describe : describe.skip;

/**
 * Viewport presets against a real Chromium: mobile flags apply at launch, sizes resize live,
 * and the wish survives a restart.
 *
 * Persistent contexts with real profile directories, so this also proves the preference file
 * does not disturb the profile it sits beside.
 */
maybe("viewport presets", () => {
  let root = "";

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "viewport-smoke-"));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("mobile preset launches small with touch, desktop resizes live", async () => {
    const profiles = createProfiles(root);
    const set = await profiles.setViewport("bot", { preset: "mobile" });
    expect(set.restarted).toBe(false);
    expect(set.spec).toMatchObject({ width: 390, height: 844 });

    const page = await profiles.page("bot");
    try {
      expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
      // maxTouchPoints, not `ontouchstart in window`: headless Chromium reports touch support
      // through the former while leaving the latter absent.
      expect(
        await page.evaluate(() => navigator.maxTouchPoints),
      ).toBeGreaterThan(0);

      const resized = await profiles.setViewport("bot", { preset: "desktop" });
      expect(resized.restarted).toBe(true);
      const page2 = await profiles.page("bot");
      expect(page2.viewportSize()).toEqual({ width: 1440, height: 900 });

      const live = await profiles.setViewport("bot", {
        width: 1280,
        height: 800,
      });
      expect(live.restarted).toBe(false);
      expect(page2.viewportSize()).toEqual({ width: 1280, height: 800 });
      expect(await profiles.currentViewport("bot")).toMatchObject({
        width: 1280,
        height: 800,
      });
    } finally {
      await profiles.stop("bot");
    }
  });
});
