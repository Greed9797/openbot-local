/**
 * The QA run manifest: what the operator declared before anything acted.
 *
 * The Shopify QA stalled on questions that should never be asked mid-run — which environment is
 * this, whose data may be entered, is that gateway real. This module asks them up front and derives
 * the limits from the answers, so a run cannot start a checkout on production with a live gateway
 * because nobody got around to confirming it.
 */

export type QAEnvironment =
  | "preview"
  | "staging"
  | "development"
  | "production";

export type QAManifestInput = {
  environment?: unknown;
  scope?: { country?: unknown; language?: unknown; currency?: unknown };
  identity?: {
    name?: unknown;
    email?: unknown;
    phone?: unknown;
    address?: unknown;
    cep?: unknown;
  };
  gateway?: { testMode?: unknown };
  /** Session state (cart, wishlist) is always allowed. Checkout and form submission are not. */
  allowCheckout?: unknown;
  allowFormSubmit?: unknown;
};

export type QAManifest = {
  environment: QAEnvironment;
  scope: { country: string; language: string; currency: string };
  identity: {
    name: string;
    email: string;
    phone: string;
    address: string;
    cep: string;
  };
  gateway: { testMode: boolean };
  limits: {
    /** Starting a checkout: needs an explicit yes AND a test-mode gateway. */
    mayStartCheckout: boolean;
    /** Submitting any form: needs an explicit yes, and never on production. */
    maySubmitForms: boolean;
  };
};

/**
 * Clearly fake, clearly labeled. Fictitious data is not a placeholder the operator fills in later:
 * it is the only data a QA run may enter, and `@example.test` plus a zeroed phone number make a
 * real submission recognizable as a mistake rather than as a customer.
 */
export const TEST_IDENTITY = {
  name: "QA Teste",
  email: "qa-teste@example.test",
  phone: "+55 00 00000-0000",
  address: "Rua Fictícia, 0",
  cep: "00000-000",
} as const;

const ENVIRONMENTS: QAEnvironment[] = [
  "preview",
  "staging",
  "development",
  "production",
];

const nonEmpty = (value: unknown, field: string): string => {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`QA manifest needs ${field}.`);
  }
  return value;
};

export function validateManifest(input: QAManifestInput): QAManifest {
  const environment = input.environment;
  if (
    typeof environment !== "string" ||
    !ENVIRONMENTS.includes(environment as QAEnvironment)
  ) {
    throw new Error(
      `QA manifest needs environment: one of ${ENVIRONMENTS.join(", ")}. Guessing production would risk a live store; guessing preview would waste a run.`,
    );
  }
  const scope = input.scope ?? {};
  const identity = { ...TEST_IDENTITY, ...(input.identity ?? {}) };
  const testMode = input.gateway?.testMode === true;
  const allowCheckout = input.allowCheckout === true;
  const allowFormSubmit = input.allowFormSubmit === true;

  return {
    environment,
    scope: {
      country: nonEmpty(scope.country, "scope.country"),
      language: nonEmpty(scope.language, "scope.language"),
      currency: nonEmpty(scope.currency, "scope.currency"),
    },
    identity: {
      name: nonEmpty(identity.name, "identity.name"),
      email: nonEmpty(identity.email, "identity.email"),
      phone: nonEmpty(identity.phone, "identity.phone"),
      address: nonEmpty(identity.address, "identity.address"),
      cep: nonEmpty(identity.cep, "identity.cep"),
    },
    gateway: { testMode },
    limits: {
      mayStartCheckout: allowCheckout && testMode,
      maySubmitForms: allowFormSubmit && environment !== "production",
    },
  };
}
