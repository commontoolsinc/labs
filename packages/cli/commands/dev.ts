import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { render } from "../lib/render.ts";
import { process } from "../lib/dev.ts";
import { isRecord } from "@commontools/utils/types";

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
    "--show-transformed",
    "Show only the transformed TypeScript source code without executing the recipe.",
  )
  .arguments("<main:string>")
  .action(async (options, main) => {
    const { main: exports } = await process({
      main: join(Deno.cwd(), main),
      check: options.check,
      run: options.run,
      output: options.output,
      filename: options.filename,
      showTransformed: options.showTransformed,
    });
    // If --show-transformed is used, the transformed source is already printed to stdout
    // and we don't want to print the JSON output
    if (!options.showTransformed && exports) {
      const mainExport = "default" in exports ? exports.default : exports;
      try {
        // Stringify before rendering, as the exported
        // recipe is a function with extra properties via Object.assign
        render(JSON.stringify(mainExport, null, 2));
      } catch (_) {
        if (isRecord(mainExport) && typeof mainExport.toString === "function") {
          render(mainExport.toString());
        } else {
          throw new Error("Main export not serializable.");
        }
      }
    }
  });
