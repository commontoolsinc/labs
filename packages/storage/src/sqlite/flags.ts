import type { Database } from "@db/sqlite";
import { getGlobalServerMergeFlag } from "../config.ts";

// Per-space settings live in a simple key/value JSON table.
// A value of { enableServerMerge: boolean } under key 'settings' can override flags.

export function isServerMergeEnabled(db: Database): boolean {
  // Global env default
  const globalEnabled = getGlobalServerMergeFlag();

  try {
    const row = db.prepare(
      `SELECT value_json FROM space_settings WHERE key = 'settings'`
    ).get() as { value_json: string } | undefined;
    if (!row) return globalEnabled;
    const settings = JSON.parse(row.value_json) as { enableServerMerge?: boolean };
    if (typeof settings.enableServerMerge === "boolean") {
      return settings.enableServerMerge;
    }
    return globalEnabled;
  } catch {
    // If table not present or parse fails, fall back to global
    return globalEnabled;
  }
}

