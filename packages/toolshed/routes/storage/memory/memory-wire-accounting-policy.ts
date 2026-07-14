// Pure access policy for the Memory v2 wire-accounting diagnostic endpoint.
// The endpoint exists only when a non-empty random token is configured and ENV
// is an explicit local/dev test value. Unknown aliases fail closed.

const ENABLED_ENVS = new Set(["development", "test"]);

export function isMemoryWireAccountingEnabled(cfg: {
  token: string;
  env: string;
}): boolean {
  if (cfg.token.trim().length === 0) return false;
  return ENABLED_ENVS.has(cfg.env.toLowerCase());
}
