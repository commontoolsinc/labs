import { Command } from "@cliffy/command";
import { join } from "@std/path";
import { render } from "../lib/render.ts";
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
    "--debug",
    "Enable debug logging for transformers (shows transformed code).",
  )
  .arguments("<main:string>")
  .action(async (options, main) => {
    const { main: exports } = await process({
      main: join(Deno.cwd(), main),
      check: options.check,
      run: options.run,
      output: options.output,
      filename: options.filename,
      debug: options.debug,
    });
    if (exports) {
      const mainExport = "default" in exports ? exports.default : exports;
      try {
        // Stringify before rendering, as the exported
        // recipe is a function with extra properties via Object.assign
        render(JSON.stringify(mainExport, null, 2));
      } catch (_) {
        render(mainExport.toString());
      }
    }
  });
