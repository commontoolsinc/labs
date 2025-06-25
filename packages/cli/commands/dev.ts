import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { handleCommand } from "../lib/handler.ts";
import { process } from "../lib/dev.ts";

export const dev = new Command()
  .name("dev")
  .description("Compile and execute recipes for debugging.")
  .example(
    "ct dev ./recipe.tsx",
    "Locally compile and evaluate a recipe, printing export default to stdout.",
  )
  .example(
    "ct dev ./recipe.tsx --no-run --output out.js",
    "Locally compile a recipe, storing the translated and bundled JavaScript to out.js without evaluating the recipe.",
  )
  .example(
    "ct dev ./recipe.tsx --no-check",
    "Locally compile and evaluate recipe without typechecking.",
  )
  .option("--no-run", "Do not execute input, only type check.")
  .option("--no-check", "Do not type check input.")
  .option(
    "--output <value:string>",
    "Store the compiled recipe at $output.",
  )
  .option(
    "--filename <value:string>",
    "The filename used when compiling the recipe, used in source maps.",
  )
  .option(
    "-v,--verbose",
    "Enable verbose output.",
  )
  .arguments("<entry:string>")
  .action(async (options, entry) =>
    await handleCommand(devCommand(options, entry), options)
  );

async function devCommand(
  options: {
    run: boolean;
    check: boolean;
    filename?: string;
    output?: string;
    verbose?: true;
  },
  entry: string,
): Promise<string | undefined> {
  const { exports } = await process({
    entry: join(Deno.cwd(), entry),
    check: options.check,
    run: options.run,
    output: options.output,
    filename: options.filename,
    verbose: options.verbose,
  });
  if (exports) {
    const mainExport = "default" in exports ? exports.default : exports;
    // Stringify before handleCommanding, as the exported
    // recipe is a function with extra properties via Object.assign
    return JSON.stringify(mainExport, null, 2);
  }
}
