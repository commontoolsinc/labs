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

