// Pure access policy for the memory dump endpoint. Kept dependency-free (no env,
// no server) so the security matrix — opt-in and prod refusal, and the allowlist
// union — is unit-tested directly rather than only via comments.

const parseDids = (csv: string): string[] =>
  csv.split(",").map((d) => d.trim()).filter((d) => d.length > 0);

/**
 * Whether the dump endpoint should be served in this environment at all.
 *
 * The REAL boundary is (a) the tailnet perimeter and (b) opt-in being off by
 * default — the endpoint only mounts when someone deliberately sets
 * MEMORY_DUMP_ENABLED on a staging host. The `ENV === "production"` refusal is
 * belt-and-suspenders, NOT load-bearing: `ENV` is a free-form string, so a
 * deployment that sets `ENV=prod` or leaves it unset would not match here — do
 * not rely on it as the sole guard. There is intentionally no override to turn
 * raw whole-space dumps on in production; a prod form is a separate mechanism.
 */
export function isDumpEnabled(cfg: {
  enabled: boolean | undefined;
  env: string;
}): boolean {
  if (!cfg.enabled) return false;
  if (cfg.env === "production") return false;
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
