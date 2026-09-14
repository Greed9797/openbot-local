import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";

const base = {
  DATABASE_URL: "postgres://openbot:openbot@localhost:5432/openbot",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  BETTER_AUTH_SECRET: "a-long-enough-local-development-auth-secret",
  BETTER_AUTH_URL: "http://localhost:3001",
  INITIAL_ADMIN_EMAILS: "admin@openbot.test",
  MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

const smtp = {
  AUTH_EMAIL_PASSWORD_ENABLED: "true",
  SMTP_HOST: "mail.example.test",
  SMTP_PORT: "587",
  SMTP_USER: "openbot",
  SMTP_PASSWORD: "secret",
  SMTP_FROM: "openbot@example.test",
};

describe("email/password configuration", () => {
  test("off unless explicitly enabled", () => {
    const { BETTER_AUTH_SECRET: _s, BETTER_AUTH_URL: _u, ...noAuth } = base;
    void _s;
    void _u;
    expect(loadConfig({ ...noAuth, OPENBOT_SINGLE_USER: "true" }).auth?.emailPassword).toBeUndefined();
  });
  test("parses SMTP with STARTTLS default on 587", () => {
    const auth = loadConfig({ ...base, ...smtp }).auth;
    expect(auth?.emailPassword?.smtp).toMatchObject({
      host: "mail.example.test",
      port: 587,
      secure: false,
    });
  });

  test("465 defaults to implicit TLS", () => {
    const auth = loadConfig({ ...base, ...smtp, SMTP_PORT: "465" }).auth;
    expect(auth?.emailPassword?.smtp.secure).toBe(true);
  });

  test("refuses enablement without SMTP", () => {
    expect(() =>
      loadConfig({ ...base, AUTH_EMAIL_PASSWORD_ENABLED: "true" }),
    ).toThrow("SMTP_HOST");
  });

  test("refuses a bad SMTP port", () => {
    expect(() =>
      loadConfig({ ...base, ...smtp, SMTP_PORT: "not-a-port" }),
    ).toThrow("SMTP_PORT");
  });
});
