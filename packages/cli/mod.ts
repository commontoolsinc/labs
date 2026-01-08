import { parse } from "./commands/mod.ts";
import { CompilerError, TransformerError } from "@commontools/js-compiler";

export async function main(args: string[]) {
  try {
    await parse(args);
    Deno.exit(0);
  } catch (e) {
    // TransformerError and CompilerError have nicely formatted messages
    // Just print the message without stack trace
    if (e instanceof TransformerError || e instanceof CompilerError) {
      console.error(e.message);
    } else if (e instanceof Error) {
      // For other errors, print message and stack trace
      console.error(e.message);
      if (e.stack) {
        console.error(e.stack);
      }
    } else {
      console.error(e);
    }
    Deno.exit(1);
  }
}

if (import.meta.main) {
  main(Deno.args);
}
