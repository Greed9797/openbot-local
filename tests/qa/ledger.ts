/**
 * The QA ledger: every discovered page and element ends with a terminal status.
 *
 * The report that motivated this stays open while anything is unexamined; this ledger makes that
 * rule structural. Entries are added as `pending` and the run cannot close until each one carries
 * exactly one of `passed`, `failed`, `blocked` or `skipped_with_reason` — anything else, including
 * a missing reason on a skip, keeps `close()` throwing.
 */

export type LedgerStatus =
  | "pending"
  | "passed"
  | "failed"
  | "blocked"
  | "skipped_with_reason";

export type LedgerEntry = {
  id: string;
  page: string;
  element: string;
  action: string;
  expected: string;
  result?: string;
  evidence?: string;
  status: LedgerStatus;
  reason?: string;
};

export type Ledger = {
  add(entry: Omit<LedgerEntry, "status"> & { status?: LedgerStatus }): void;
  set(
    id: string,
    status: Exclude<LedgerStatus, "pending">,
    fields?: { result?: string; evidence?: string; reason?: string },
  ): void;
  close(): LedgerEntry[];
};

export function createLedger(): Ledger {
  const entries = new Map<string, LedgerEntry>();
  return {
    add(entry) {
      if (entries.has(entry.id)) {
        throw new Error(`Ledger entry ${entry.id} already exists.`);
      }
      entries.set(entry.id, { ...entry, status: entry.status ?? "pending" });
    },

    set(id, status, fields) {
      const entry = entries.get(id);
      if (!entry) throw new Error(`Ledger entry ${id} does not exist.`);
      if (status === "skipped_with_reason" && !fields?.reason?.trim()) {
        throw new Error(`Ledger entry ${id} is skipped without a reason.`);
      }
      if (
        (status === "blocked" || status === "failed") &&
        !fields?.reason?.trim()
      ) {
        throw new Error(
          `Ledger entry ${id} is ${status} without saying what is needed.`,
        );
      }
      entries.set(id, { ...entry, ...fields, status });
    },

    close() {
      const open = [...entries.values()].filter(
        (entry) => entry.status === "pending",
      );
      if (open.length > 0) {
        throw new Error(
          `QA is not closed: ${open.length} entries without a terminal status (${open.map((entry) => entry.id).join(", ")}).`,
        );
      }
      return [...entries.values()];
    },
  };
}
