import { parse } from "./commands/mod.ts";
import { CompilerError, TransformerError } from "@commonfabric/js-compiler";
import { cliName } from "./lib/cli-name.ts";
import { applyLogLevel } from "./lib/log-level.ts";

/**
 * The value to print for a top-level CLI failure. TransformerError and
 * CompilerError carry pre-formatted messages, so print those without a stack
 * trace; other Errors print their stack (falling back to the message); anything
 * else prints as-is.
 */
export function renderCliError(e: unknown): unknown {
  if (e instanceof TransformerError || e instanceof CompilerError) {
    return e.message;
  }
  if (e instanceof Error) {
    return e.stack || e.message;
  }
  return e;
}

export async function main(args: string[]) {
  // Extract --log-level before Cliffy parses and apply the resulting floor.
  const cleanArgs = applyLogLevel(args);
  Deno.env.set("CF_CLI_NAME", cliName());
  const profileDoneMarker = Deno.env.get("CF_PROFILE_DONE_MARKER");

  try {
    await parse(cleanArgs);
    if (profileDoneMarker) {
      console.log(profileDoneMarker);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    Deno.exit(0);
  } catch (e) {
    console.error(renderCliError(e));
    if (profileDoneMarker) {
      console.log(profileDoneMarker);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main(Deno.args);
}
