import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { authRateLimits } from "../db/schema";

/** Fixed-window counter in Postgres. Returns false when the limit is spent. */
export async function checkRateLimit(
  database: Database,
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<boolean> {
  const [row] = await database
    .select()
    .from(authRateLimits)
    .where(eq(authRateLimits.key, key))
    .limit(1);
  if (!row || now - row.windowStartedAt.getTime() >= windowMs) {
    await database
      .insert(authRateLimits)
      .values({ key, count: 1, windowStartedAt: new Date(now) })
      .onConflictDoUpdate({
        target: authRateLimits.key,
        set: { count: 1, windowStartedAt: new Date(now) },
      });
    return true;
  }
  if (row.count >= limit) return false;
  await database
    .update(authRateLimits)
    .set({ count: row.count + 1 })
    .where(eq(authRateLimits.key, key));
  return true;
}

export function ipKey(ip: string, endpoint: string): string {
  return `ip:${endpoint}:${ip || "unknown"}`;
}

export function recipientKey(kind: string, email: string): string {
  return `to:${kind}:${email.trim().toLowerCase()}`;
}
