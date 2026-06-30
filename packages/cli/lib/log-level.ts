import { type LogLevel, setGlobalLogFloor } from "@commonfabric/utils/logger";

const VALID_LOG_LEVELS = new Set([
  "debug",
  "info",
  "warn",
  "error",
  "silent",
]);

/**
 * Extract --log-level <level> from args before Cliffy sees them.
 * Returns the level (if found) and the cleaned args array.
 */
export function extractLogLevel(
  args: string[],
): { level: string | undefined; args: string[] } {
  const cleaned: string[] = [];
  let level: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--log-level" && i + 1 < args.length) {
      const candidate = args[i + 1];
      if (VALID_LOG_LEVELS.has(candidate)) {
        level = candidate;
        i++; // skip the value
        continue;
      }
    }
    cleaned.push(args[i]);
  }
  return { level, args: cleaned };
}

/**
 * Resolve the global log floor from CLI args and apply it, returning the args
 * with `--log-level <level>` removed.
 *
 * An explicit `--log-level` wins. Otherwise a pre-set `CF_LOG_LEVEL` env var is
 * left as-is (its floor was applied at module load). Otherwise the floor
 * defaults to `warn` so transformer-pipeline diagnostics reach authors; on the
 * happy path no runtime `logger.warn` fires, so this stays quiet in practice.
 */
export function applyLogLevel(args: string[]): string[] {
  const { level, args: cleanArgs } = extractLogLevel(args);
  if (level) {
    setGlobalLogFloor(level as LogLevel);
    Deno.env.set("CF_LOG_LEVEL", level); // workers inherit
  } else if (!Deno.env.get("CF_LOG_LEVEL")) {
    setGlobalLogFloor("warn" as LogLevel);
    Deno.env.set("CF_LOG_LEVEL", "warn");
  }
  return cleanArgs;
}
