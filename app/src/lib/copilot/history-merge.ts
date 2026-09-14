import type { Message } from "@ag-ui/core";

/**
 * Saved history first, a local update of the same id wins, new local
 * messages stay at the end.
 *
 * The restore must never overwrite turns the person already started while it
 * was loading, and a run must never start without the history it belongs to.
 */
export function mergeHistoryMessages(
  stored: readonly Message[],
  local: readonly Message[],
): Message[] {
  if (stored.length === 0) return [...local];
  const localById = new Map(local.map((message) => [message.id, message]));
  const merged: Message[] = [];
  for (const saved of stored) {
    merged.push(localById.get(saved.id) ?? saved);
    localById.delete(saved.id);
  }
  for (const message of local) {
    if (localById.has(message.id)) merged.push(message);
  }
  return merged;
}
