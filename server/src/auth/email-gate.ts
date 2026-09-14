import type { Context } from "hono";
import type { Database } from "../db/client";
import { findValidEnrollment } from "../people/enrollments";
import type { AppVariables } from "./guards";
import { checkRateLimit, ipKey, recipientKey } from "./rate-limit";

type GateContext = Context<{ Variables: AppVariables }>;

/** 5 attempts/minute per IP+endpoint. */
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_MS = 60_000;
/** 5 emails/15 minutes per normalized recipient. */
const EMAIL_LIMIT = 5;
const EMAIL_WINDOW_MS = 15 * 60_000;

function ipOf(context: GateContext): string {
  const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || context.req.header("x-real-ip")?.trim() || "unknown";
}

async function bodyEmail(context: GateContext): Promise<string> {
  const body = (await context.req.json().catch(() => null)) as {
    email?: unknown;
  } | null;
  return typeof body?.email === "string" ? body.email : "";
}

/**
 * Totem na frente do Better Auth para o método email/senha.
 *
 * Better Auth recebe todo `/api/auth/*`, então "cadastro só com convite" e os
 * limites de tentativa precisam morar aqui, antes da delegação. OAuth não
 * passa por este portão: quem decide quem existe num diretório é o IdP.
 */
export async function emailAuthGate(
  database: Database,
  context: GateContext,
): Promise<Response | undefined> {
  const url = new URL(context.req.url);
  const path = url.pathname;
  const method = context.req.method.toUpperCase();
  const ip = ipOf(context);

  if (method === "POST" && path === "/api/auth/sign-up/email") {
    const email = await bodyEmail(context);
    if (
      !(await checkRateLimit(database, ipKey(ip, "sign-up"), ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS))
    ) {
      return context.json({ error: "Too many attempts. Try again later." }, 429);
    }
    if (!(await checkRateLimit(database, recipientKey("sign-up", email), EMAIL_LIMIT, EMAIL_WINDOW_MS))) {
      return context.json({ error: "Too many attempts. Try again later." }, 429);
    }
    if (!email || !(await findValidEnrollment(database, email))) {
      return context.json({ error: "This email has no invitation." }, 403);
    }
    return undefined;
  }

  if (method === "POST" && path === "/api/auth/sign-in/email") {
    if (
      !(await checkRateLimit(database, ipKey(ip, "sign-in"), ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS))
    ) {
      return context.json({ error: "Too many attempts. Try again later." }, 429);
    }
    return undefined;
  }

  if (method === "GET" && path === "/api/auth/verify-email") {
    if (
      !(await checkRateLimit(database, ipKey(ip, "verify"), ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS))
    ) {
      return context.json({ error: "Too many attempts. Try again later." }, 429);
    }
    return undefined;
  }

  if (method === "POST" && path === "/api/auth/request-password-reset") {
    const email = await bodyEmail(context);
    if (
      !(await checkRateLimit(database, ipKey(ip, "reset-request"), ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS))
    ) {
      // Generic even under pressure: never reveal whether the address exists.
      return context.json({ status: true }, 200);
    }
    if (
      email &&
      !(await checkRateLimit(database, recipientKey("reset", email), EMAIL_LIMIT, EMAIL_WINDOW_MS))
    ) {
      return context.json({ status: true }, 200);
    }
    return undefined;
  }

  if (method === "POST" && path === "/api/auth/reset-password") {
    if (
      !(await checkRateLimit(database, ipKey(ip, "reset"), ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS))
    ) {
      return context.json({ error: "Too many attempts. Try again later." }, 429);
    }
    return undefined;
  }

  return undefined;
}
