import { describe, expect, test } from "bun:test";
import { deriveComputerToken } from "../../shared/computer-token";

/**
 * One secret per Bot computer.
 *
 * The property that matters is negative: a token derived for one Bot must not authenticate
 * another's computer, whatever header the caller attaches, because the computer compares against
 * its own derived value and never sees the master. These tests pin the derivation so both sides
 * stay on it; the transport and supervisor tests pin that each side actually uses it.
 */
describe("deriveComputerToken", () => {
  test("is deterministic for the same master and Bot", () => {
    expect(deriveComputerToken("master", "vendas")).toBe(
      deriveComputerToken("master", "vendas"),
    );
  });

  test("a different Bot gets a different token", () => {
    expect(deriveComputerToken("master", "vendas")).not.toBe(
      deriveComputerToken("master", "livelab"),
    );
  });

  test("a different master gets a different token", () => {
    expect(deriveComputerToken("master-a", "vendas")).not.toBe(
      deriveComputerToken("master-b", "vendas"),
    );
  });

  test("is a 64-character lowercase hex digest", () => {
    expect(deriveComputerToken("master", "vendas")).toMatch(/^[0-9a-f]{64}$/);
  });
});
