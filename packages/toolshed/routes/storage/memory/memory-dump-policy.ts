// Pure access policy for the memory dump endpoint. Kept dependency-free (no env,
// no server) so the security matrix — opt-in, production defense-in-depth, and
// the allowlist union — is unit-tested directly rather than only via comments.

const parseDids = (csv: string): string[] =>
  csv.split(",").map((d) => d.trim()).filter((d) => d.length > 0);

/** Whether the dump endpoint should be served in this environment at all. */
export function isDumpEnabled(cfg: {
  enabled: boolean | undefined;
  env: string;
  allowInProduction: boolean | undefined;
}): boolean {
  if (!cfg.enabled) return false;
  // Defense in depth: never expose raw dumps in production unless explicitly
  // and separately opted in.
  if (cfg.env === "production" && !cfg.allowInProduction) return false;
  return true;
}

/** DIDs permitted to download dumps (MEMORY_DUMP_DIDS ∪ MEMORY_SERVICE_DIDS). */
export function dumpAllowSet(cfg: {
  dumpDids: string;
  serviceDids: string;
}): Set<string> {
  return new Set([
    ...parseDids(cfg.dumpDids),
    ...parseDids(cfg.serviceDids),
  ]);
}
