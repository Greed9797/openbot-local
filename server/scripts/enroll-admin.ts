import { eq } from "drizzle-orm";
import { loadConfig } from "../src/config";
import { createDatabase } from "../src/db/client";
import { sectorEnrollments } from "../src/db/schema";
import { inviteEnrollment } from "../src/people/enrollments";

const emailFlag = process.argv.find((a) => a.startsWith("--email="));
const emailPosIndex = process.argv.indexOf("--email");
const emailPos =
  emailPosIndex >= 0 ? process.argv[emailPosIndex + 1] : undefined;
const email = (emailFlag?.slice("--email=".length) ?? emailPos ?? "").trim();
if (!email) {
  console.error(
    "Usage: bun server/scripts/enroll-admin.ts --email <real-email>",
  );
  process.exit(1);
}
const config = loadConfig(process.env as Record<string, string>);
const database = createDatabase(config.database.url);
try {
  const row = await inviteEnrollment(database, {
    email,
    name: "Administrator",
    sectorId: null,
    role: "admin",
  });
  console.log(`Admin enrollment ready for ${row.email}.`);
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("already invited")) {
    const [existing] = await database
      .select()
      .from(sectorEnrollments)
      .where(eq(sectorEnrollments.email, email.toLowerCase()))
      .limit(1);
    if (existing) {
      console.log(`Admin enrollment ready for ${existing.email}.`);
      process.exit(0);
    }
  }
  throw error;
}
process.exit(0);
