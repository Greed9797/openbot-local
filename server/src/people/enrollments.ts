import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { sectorEnrollments, sectors, userRoles, users } from "../db/schema";
import { seedSectors } from "../sectors/store";

export type EnrollmentInput = {
  email: string;
  name: string;
  sectorId: string | null;
  role: "user" | "admin";
};

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function enrollmentExpiry(): Date {
  return new Date(Date.now() + 72 * 3600 * 1000);
}

export async function findValidEnrollment(database: Database, email: string) {
  const key = normalizeEmail(email);
  const [row] = await database
    .select()
    .from(sectorEnrollments)
    .where(eq(sectorEnrollments.email, key))
    .limit(1);
  if (!row || row.acceptedUserId) return null;
  if (row.expiresAt && row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export async function inviteEnrollment(
  database: Database,
  input: EnrollmentInput,
): Promise<typeof sectorEnrollments.$inferSelect> {
  const email = normalizeEmail(input.email);
  if (!email || !email.includes("@")) throw new Error("A valid email is required.");
  if (!input.name.trim()) throw new Error("A name is required.");
  if (input.role === "user" && !input.sectorId)
    throw new Error("A sector is required for user invites.");
  if (input.role === "admin" && input.sectorId)
    throw new Error("Admin invites must not bind a sector.");
  if (input.sectorId) {
    const [sector] = await database
      .select({ id: sectors.id, ownerUserId: sectors.ownerUserId })
      .from(sectors)
      .where(eq(sectors.id, input.sectorId))
      .limit(1);
    if (!sector) throw new Error("Unknown sector.");
    if (sector.ownerUserId) throw new Error("Sector already has an owner.");
    const clash = await database
      .select({ email: sectorEnrollments.email })
      .from(sectorEnrollments)
      .where(eq(sectorEnrollments.sectorId, input.sectorId))
      .limit(1);
    if (clash.length > 0) throw new Error("Sector already invited.");
  }
  const [row] = await database
    .insert(sectorEnrollments)
    .values({
      email,
      name: input.name.trim(),
      sectorId: input.sectorId,
      role: input.role,
      expiresAt: enrollmentExpiry(),
    })
    .onConflictDoNothing({ target: sectorEnrollments.email })
    .returning();
  if (row) return row;
  const [existing] = await database
    .select()
    .from(sectorEnrollments)
    .where(eq(sectorEnrollments.email, email))
    .limit(1);
  if (!existing) throw new Error("Enrollment could not be created.");
  if (existing.acceptedUserId) throw new Error("Email already enrolled.");
  throw new Error("Email already invited.");
}

export async function resendEnrollment(
  database: Database,
  email: string,
): Promise<typeof sectorEnrollments.$inferSelect> {
  const key = normalizeEmail(email);
  const [existing] = await database
    .select()
    .from(sectorEnrollments)
    .where(eq(sectorEnrollments.email, key))
    .limit(1);
  if (!existing) throw new Error("Enrollment not found.");
  if (existing.acceptedUserId) throw new Error("Enrollment already accepted.");
  const [row] = await database
    .update(sectorEnrollments)
    .set({ expiresAt: enrollmentExpiry() })
    .where(eq(sectorEnrollments.email, key))
    .returning();
  if (!row) throw new Error("Enrollment not found.");
  return row;
}

export async function acceptEnrollment(
  database: Database,
  email: string,
  userId: string,
): Promise<void> {
  const key = normalizeEmail(email);
  await database.transaction(async (tx) => {
    const [enrollment] = await tx
      .select()
      .from(sectorEnrollments)
      .where(eq(sectorEnrollments.email, key))
      .limit(1)
      .for("update");
    if (!enrollment) throw new Error("No invitation for this email.");
    if (enrollment.acceptedUserId) return;
    if (
      enrollment.expiresAt &&
      enrollment.expiresAt.getTime() < Date.now()
    )
      throw new Error("Invitation expired.");
    const [user] = await tx
      .select({ id: users.id, email: users.email, emailVerified: users.emailVerified })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!user) throw new Error("Unknown user.");
    if (normalizeEmail(user.email) !== key)
      throw new Error("Email mismatch.");
    if (!user.emailVerified) throw new Error("Email not verified.");
    await seedSectors(tx as unknown as Database);
    if (enrollment.sectorId) {
      await tx
        .update(sectors)
        .set({ ownerUserId: userId, updatedAt: new Date() })
        .where(eq(sectors.id, enrollment.sectorId));
    }
    await tx.insert(userRoles).values({ userId, role: enrollment.role }).onConflictDoNothing();
    await tx
      .update(sectorEnrollments)
      .set({ acceptedUserId: userId })
      .where(eq(sectorEnrollments.email, key));
  });
}
