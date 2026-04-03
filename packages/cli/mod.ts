import { parse } from "./commands/mod.ts";
import { CompilerError, TransformerError } from "@commonfabric/js-compiler";
import { type LogLevel, setGlobalLogFloor } from "@commonfabric/utils/logger";
import { cliName } from "./lib/cli-name.ts";

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
function extractLogLevel(
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

export async function main(args: string[]) {
  // Extract --log-level before Cliffy parses
  const { level, args: cleanArgs } = extractLogLevel(args);
  Deno.env.set("CF_CLI_NAME", cliName());

  if (level) {
    setGlobalLogFloor(level as LogLevel);
    Deno.env.set("CF_LOG_LEVEL", level); // workers inherit
  } else if (!Deno.env.get("CF_LOG_LEVEL")) {
    setGlobalLogFloor("error" as LogLevel); // default: only errors
    Deno.env.set("CF_LOG_LEVEL", "error");
  }
  // If CF_LOG_LEVEL env var already set, floor was initialized at module load time

  try {
    await parse(cleanArgs);
    Deno.exit(0);
  } catch (e) {
    // TransformerError and CompilerError have nicely formatted messages
    // Just print the message without stack trace
    if (e instanceof TransformerError || e instanceof CompilerError) {
      console.error(e.message);
    } else if (e instanceof Error) {
      console.error(e.stack ?? e.message);
    } else {
      console.error(e);
    }
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main(Deno.args);
}
