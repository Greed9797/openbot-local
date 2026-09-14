import { describe, expect, test } from "bun:test";
import {
  BrowserCapacityError,
  SectorConflictError,
  admissionVerdict,
} from "../src/docker";

describe("admissionVerdict", () => {
  test("admits the first computer into an empty fleet", () => {
    expect(
      admissionVerdict({ botId: "bot-a", sectorId: "livelab" }, [], 6),
    ).toEqual({ admit: true });
  });

  test("refuses the seventh browser with a wait", () => {
    const fleet = Array.from({ length: 6 }, (_, index) => ({
      botId: `bot-${index}`,
      sectorId: `sector-${index}`,
      active: true,
    }));
    const verdict = admissionVerdict(
      { botId: "bot-new", sectorId: "sector-new" },
      fleet,
      6,
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) {
      expect(verdict.message).toMatch(/6 of 6 slots/);
    }
    const error = new BrowserCapacityError("full");
    expect(error.code).toBe("BROWSER_CAPACITY_WAIT");
    expect(error.retryAfterMs).toBe(30_000);
  });

  test("stopped computers hold no slot", () => {
    const fleet = [
      ...Array.from({ length: 6 }, (_, index) => ({
        botId: `bot-${index}`,
        sectorId: `sector-${index}`,
        active: false,
      })),
    ];
    expect(
      admissionVerdict({ botId: "bot-new", sectorId: "sector-new" }, fleet, 6),
    ).toEqual({ admit: true });
  });

  test("refuses a second live computer in the same sector", () => {
    const verdict = admissionVerdict(
      { botId: "bot-b", sectorId: "livelab" },
      [{ botId: "bot-a", sectorId: "livelab", active: true }],
      6,
    );
    expect(verdict.admit).toBe(false);
    if (!verdict.admit) {
      expect(verdict.message).toMatch(/livelab/);
    }
  });

  test("a stopped computer does not block its sector", () => {
    expect(
      admissionVerdict(
        { botId: "bot-b", sectorId: "livelab" },
        [{ botId: "bot-a", sectorId: "livelab", active: false }],
        6,
      ),
    ).toEqual({ admit: true });
  });

  test("a restart of the same Bot reuses its own slot", () => {
    const fleet = [
      { botId: "bot-a", sectorId: "livelab", active: false },
      ...Array.from({ length: 5 }, (_, index) => ({
        botId: `bot-${index}`,
        sectorId: `sector-${index}`,
        active: true,
      })),
    ];
    expect(
      admissionVerdict({ botId: "bot-a", sectorId: "livelab" }, fleet, 6),
    ).toEqual({ admit: true });
  });

  test("sector conflict carries its code", () => {
    const error = new SectorConflictError("wrong sector");
    expect(error.code).toBe("COMPUTER_SECTOR_CONFLICT");
  });
});
