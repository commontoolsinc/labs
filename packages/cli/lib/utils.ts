import { isAbsolute, join } from "@std/path";
import type { ExperimentalOptions } from "@commontools/runner";

export function absPath(relpath: string, cwd = Deno.cwd()): string {
  // TODO(js): homedir check is not cross platform
  if (isAbsolute(relpath) || relpath[0] === "~") {
    // Do not join a home dir or absolute path
    return relpath;
  }
  return join(cwd, relpath);
}

/**
 * Read EXPERIMENTAL_* env vars and return an ExperimentalOptions object.
 * Mirrors the same env var names used by toolshed (env.ts) and shell
 * (felt.config.ts) so all three share one source of truth.
 */
export function experimentalOptionsFromEnv(): ExperimentalOptions {
  const read = (name: string) => Deno.env.get(name) === "true";
  const opts: ExperimentalOptions = {
    richStorableValues: read("EXPERIMENTAL_RICH_STORABLE_VALUES"),
    storableProtocol: read("EXPERIMENTAL_STORABLE_PROTOCOL"),
    unifiedJsonEncoding: read("EXPERIMENTAL_UNIFIED_JSON_ENCODING"),
    canonicalHashing: read("EXPERIMENTAL_CANONICAL_HASHING"),
  };
  const active = Object.entries(opts).filter(([, v]) => v);
  if (active.length > 0) {
    console.error(
      `[ct] Experimental flags: ${active.map(([k]) => k).join(", ")}`,
    );
  }
  return opts;
}
