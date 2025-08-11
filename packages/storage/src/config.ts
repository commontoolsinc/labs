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

export function getSpacesDir(): URL {
  const envDir = Deno.env.get("SPACES_DIR");
  return envDir
    ? new URL(envDir)
    : new URL(`.spaces/`, `file://${Deno.cwd()}/`);
}
