import { Command } from "@cliffy/command";
import { executeMountedCallableFile } from "../lib/exec.ts";
import { cliText } from "../lib/cli-name.ts";

export const exec = new Command()
  .name("exec")
  .description(
    "Execute a mounted callable file from a Common Fabric FUSE mount.",
  )
  .example(
    cliText(
      "cf exec /tmp/cf/home/pieces/notes/result/add.handler invoke --query milk",
    ),
    "Invoke a mounted handler with schema-derived flags.",
  )
  .example(
    cliText(
      "cf exec /tmp/cf/home/pieces/notes/result/search.tool --query milk",
    ),
    "Run a mounted tool using its default verb.",
  )
  .stopEarly()
  .useRawArgs()
  .arguments("<mountedFile:string> [tail...:string]")
  .action(async (_options, mountedFile, ...tail) => {
    try {
      const result = await executeMountedCallableFile(mountedFile, tail);
      if (result.helpText) {
        console.log(result.helpText);
        return;
      }
      if (result.outputText) {
        console.log(result.outputText);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      Deno.exit(1);
    }
  });
