/**
 * Where the conversation is kept between reloads.
 *
 * The library hands the record out and takes one back; it does not store. That
 * is this file, and it is the whole of it: read on open, write after a turn,
 * listen for another tab writing.
 */

import type { AiMessage } from "modelpact";

const STORAGE_KEY = "modelpact-providers-demo-chat";

export function loadRecord(): readonly AiMessage[] {
  try {
    const storedJson = localStorage.getItem(STORAGE_KEY);
    if (storedJson === null) return [];
    const parsedValue: unknown = JSON.parse(storedJson);
    return Array.isArray(parsedValue) ? (parsedValue as AiMessage[]) : [];
  } catch {
    // A private window, cleared site data, or something else in this key.
    return [];
  }
}

export function saveRecord(record: readonly AiMessage[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    // Out of quota or blocked: the conversation still works, it just will not
    // be there next time.
  }
}

export function clearRecord(): void {
  localStorage.removeItem(STORAGE_KEY);
}

/**
 * `storage` fires in every tab except the one that wrote, so this cannot loop
 * back on itself. A null key means the whole store was cleared.
 */
export function watchRecord(
  onRecord: (record: readonly AiMessage[]) => void,
): () => void {
  const handleStorageEvent = (event: StorageEvent): void => {
    if (event.key !== STORAGE_KEY && event.key !== null) return;
    onRecord(loadRecord());
  };
  window.addEventListener("storage", handleStorageEvent);
  return () => {
    window.removeEventListener("storage", handleStorageEvent);
  };
}
