/**
 * The minimum environment a deployment is allowed to boot with, for tests that need a config but are
 * not testing configuration itself.
 *
 * It lives in one place because the minimum is a moving target: Intelligence became mandatory, then
 * optional again, and five test files each carried their own copy of the environment, so every one
 * of them started failing for a reason that had nothing to do with what it was testing. Tests that
 * assert on configuration should keep building their environment inline; everything else should
 * spread this.
 *
 * This is a `local` deployment, which is the product's default: no vendor account, no licence token.
 * A test that needs Intelligence spreads {@link intelligenceEnvironment} on top.
 */
export function testEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    GOOGLE_OAUTH_CLIENT_ID: "google-client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "google-client-secret",
    BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
    BETTER_AUTH_URL: "http://localhost:3001",
    // Required whenever a provider is configured: nothing else grants the administrator role.
    INITIAL_ADMIN_EMAILS: "admin@openbot.test",
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    MANAGED_AGENT_TOKEN: "managed-agent-token",
    ...overrides,
  };
}

/**
 * The four values that turn Intelligence on, plus the switch that asks for it.
 *
 * Spread over {@link testEnvironment} by tests that are about Intelligence — chiefly the one
 * asserting that these credentials never reach an unauthenticated endpoint.
 */
export function intelligenceEnvironment(): Record<string, string> {
  return {
    RUNTIME_MODE: "intelligence",
    INTELLIGENCE_API_URL: "http://localhost:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_LICENSE_TOKEN: "license-token",
  };
}
