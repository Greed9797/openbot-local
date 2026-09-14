import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createProfiles,
  resolveViewport,
  VIEWPORT,
  VIEWPORT_PRESETS,
} from "../src/profiles";

describe("resolveViewport", () => {
  test("resolves every named preset", () => {
    for (const [name, preset] of Object.entries(VIEWPORT_PRESETS)) {
      expect(resolveViewport({ preset: name })).toEqual(preset);
    }
  });

  test("mobile is not just a small window", () => {
    const mobile = resolveViewport({ preset: "mobile" });
    expect(mobile.width).toBe(390);
    expect(mobile.isMobile).toBe(true);
    expect(mobile.hasTouch).toBe(true);
  });

  test("rejects unknown presets and bad sizes", () => {
    expect(() => resolveViewport({ preset: "watch" })).toThrow("Unknown viewport preset");
    expect(() => resolveViewport({ width: 100, height: 800 })).toThrow();
    expect(() => resolveViewport({ width: 1280, height: 800.5 })).toThrow();
    expect(() => resolveViewport({})).toThrow();
  });

  test("custom sizes stay desktop", () => {
    expect(resolveViewport({ width: 1440, height: 900 })).toEqual({
      width: 1440,
      height: 900,
      isMobile: false,
      hasTouch: false,
    });
  });
});

describe("profile viewport preference", () => {
  test("stores and reports without starting a browser", async () => {
    const root = await mkdtemp(join(tmpdir(), "viewport-"));
    try {
      const profiles = createProfiles(root);
      expect(await profiles.currentViewport("bot")).toEqual({
        ...VIEWPORT,
        isMobile: false,
        hasTouch: false,
      });
      const result = await profiles.setViewport("bot", { preset: "mobile" });
      expect(result.restarted).toBe(false);
      expect(result.spec.width).toBe(390);
      expect(await profiles.currentViewport("bot")).toEqual(result.spec);
      // A fresh handle reads the same wish from disk.
      expect(await createProfiles(root).currentViewport("bot")).toEqual(result.spec);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
