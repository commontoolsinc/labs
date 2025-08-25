// Global config for storage feature flags

export function getEnvBoolean(name: string, defaultValue = false): boolean {
  const raw = Deno.env.get(name);
  if (raw == null) return defaultValue;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

// Global flag: ENABLE_SERVER_MERGE
export function getGlobalServerMergeFlag(): boolean {
  return getEnvBoolean("ENABLE_SERVER_MERGE", false);
}

export function isJsonCacheDisabled(): boolean {
  return getEnvBoolean("DISABLE_JSON_CACHE", false);
}

export function isWsAuthRequired(): boolean {
  return getEnvBoolean("WS_V2_REQUIRE_AUTH", false);
}

export function isEpochSubscriptionsEnabled(): boolean {
  return getEnvBoolean("WS_V2_EPOCH_SUBS", false);
}

export function getSpacesDir(): URL {
  const envDir = Deno.env.get("SPACES_DIR");
  return envDir
    ? new URL(envDir)
    : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
}

// Per-space settings
import type { Database } from "@db/sqlite";

export function getSpaceSettings(db: Database): Record<string, unknown> {
  try {
    const row = db.prepare(
      `SELECT value_json FROM space_settings WHERE key = 'settings'`,
    ).get() as { value_json: string } | undefined;
    if (!row) return {};
    const settings = JSON.parse(row.value_json) as Record<string, unknown>;
    return settings ?? {};
  } catch {
    return {};
  }
}

export function isChunkingEnabled(db: Database): boolean {
  const s = getSpaceSettings(db) as { enableChunks?: boolean };
  return s.enableChunks ?? true;
}

export function getSnapshotCadence(db: Database, fallback = 5): number {
  const s = getSpaceSettings(db) as { snapshotCadence?: number };
  return typeof s.snapshotCadence === "number" ? s.snapshotCadence : fallback;
}
