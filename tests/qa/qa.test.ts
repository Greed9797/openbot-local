import { describe, expect, test } from "bun:test";
import { createLedger } from "./ledger";
import { TEST_IDENTITY, validateManifest } from "./manifest";

const SCOPE = { country: "Brasil", language: "português", currency: "BRL" };

describe("qa manifest", () => {
  test("derives checkout and submit limits from explicit answers", () => {
    const manifest = validateManifest({
      environment: "preview",
      scope: SCOPE,
      gateway: { testMode: true },
      allowCheckout: true,
      allowFormSubmit: true,
    });
    expect(manifest.limits).toEqual({
      mayStartCheckout: true,
      maySubmitForms: true,
    });
    expect(manifest.identity.email).toBe(TEST_IDENTITY.email);
  });

  test("a live gateway never unlocks checkout, even when allowed", () => {
    const manifest = validateManifest({
      environment: "preview",
      scope: SCOPE,
      gateway: { testMode: false },
      allowCheckout: true,
    });
    expect(manifest.limits.mayStartCheckout).toBe(false);
  });

  test("production never unlocks form submission", () => {
    const manifest = validateManifest({
      environment: "production",
      scope: SCOPE,
      gateway: { testMode: true },
      allowCheckout: true,
      allowFormSubmit: true,
    });
    expect(manifest.limits).toEqual({
      mayStartCheckout: true,
      maySubmitForms: false,
    });
  });

  test("refuses to guess the environment or the scope", () => {
    expect(() => validateManifest({ scope: SCOPE })).toThrow("environment");
    expect(() => validateManifest({ environment: "preview" })).toThrow(
      "scope.country",
    );
  });
});

describe("qa ledger", () => {
  test("closes only with every entry terminal and justified", () => {
    const ledger = createLedger();
    ledger.add({
      id: "QA-001",
      page: "Home",
      element: "URL",
      action: "Abrir",
      expected: "Loja carregar",
    });
    expect(() => ledger.close()).toThrow("QA-001");
    ledger.set("QA-001", "passed", { evidence: "captura" });
    expect(ledger.close()).toHaveLength(1);
  });

  test("blocked, failed and skipped entries must say what is needed", () => {
    const ledger = createLedger();
    ledger.add({
      id: "QA-1",
      page: "P",
      element: "E",
      action: "A",
      expected: "X",
    });
    expect(() => ledger.set("QA-1", "blocked")).toThrow("what is needed");
    expect(() => ledger.set("QA-1", "skipped_with_reason")).toThrow(
      "without a reason",
    );
    ledger.set("QA-1", "blocked", { reason: "sem controle de viewport" });
    expect(ledger.close()).toHaveLength(1);
  });
});
