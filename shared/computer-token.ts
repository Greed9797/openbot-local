/**
 * One secret per Bot computer, derived from a single master.
 *
 * The supervisor hands every computer the same `COMPUTER_TOKEN` today, so a credential taken from
 * one Bot's container drives any other's: the token proves the caller is an internal service, but
 * not which Bot it may touch. Deriving a token per Bot from the master keeps one secret to
 * configure while giving each computer a credential that works nowhere else.
 *
 * The master lives only in the API server and the supervisor. A computer receives solely its own
 * derived token as its `COMPUTER_TOKEN` and keeps comparing it exactly as before, which is why
 * there is no parallel acceptance of the master on a dedicated computer: it never sees it.
 *
 * This file lives in `shared/` rather than inside one package because three of them must agree on
 * it: the server derives what it sends, the supervisor derives what it hands out, and the proof
 * that the two match is a test, not a deployment. Each Dockerfile copies this single file next to
 * its own sources (see the `COPY ... computer-token.ts` lines), so the relative import below
 * resolves identically on a laptop and inside an image.
 */
import { createHmac } from "node:crypto";

/** Domain separator, so this derivation cannot be mistaken for any other HMAC in the deployment. */
const DOMAIN = "openbot:computer:v1";

/**
 * The credential for one Bot's computer.
 *
 * HMAC-SHA256 over the domain and the Bot id, hex-encoded. Deterministic on purpose: the server
 * and the supervisor derive the same value independently, so no new secret travels anywhere and no
 * lookup table has to agree. A token for `vendas` authenticates nothing on `livelab`, even when
 * the caller also names `livelab` in the Bot header, because the computer compares against its own
 * derived value rather than consulting the header.
 */
export function deriveComputerToken(master: string, botId: string): string {
  return createHmac("sha256", master)
    .update(`${DOMAIN}:${botId}`, "utf8")
    .digest("hex");
}
