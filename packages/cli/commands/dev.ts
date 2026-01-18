import { Command } from "@cliffy/command";
import { isAbsolute, join } from "@std/path";
import { render } from "../lib/render.ts";
import { process } from "../lib/dev.ts";
import { isRecord } from "@commontools/utils/types";

const devDescription = `Compile and execute patterns for debugging.

The pattern is processed through ts-transformers, which converts reactive
constructs (computed, handler, JSX) into runtime-compatible code.

By default, produces no output on success (like deno check). Use --pattern-json
to print the evaluated pattern export.

COMMON USAGE:
  ct dev ./pattern.tsx              # Compile, transform, and execute (quiet)
  ct dev ./a.tsx ./b.tsx            # Process multiple patterns
  ct dev ./pattern.tsx --pattern-json   # Print JSON result on success
  ct dev ./pattern.tsx --no-run     # Type-check only (fast validation)
  ct dev ./pattern.tsx --show-transformed   # See transformed output

TIPS:
  • Use --no-run for quick type-checking during development
  • Use --show-transformed to debug transformation issues - shows how
    ts-transformers converts your code (e.g., .map() → .mapWithPattern())
  • Transformation errors often stem from reactive constructs the compiler
    doesn't recognize; inspecting transformed output helps identify these`;

export const dev = new Command()
  .name("dev")
  .alias("check")
  .description(devDescription)
  .example(
    "ct dev ./pattern.tsx",
    "Compile and evaluate a pattern (quiet on success).",
  )
  .example(
    "ct dev ./a.tsx ./b.tsx ./c.tsx",
    "Compile and evaluate multiple patterns.",
  )
  .example(
    "ct dev ./pattern.tsx --pattern-json",
    "Compile and evaluate a pattern, printing export default as JSON.",
  )
  .example(
    "ct dev ./pattern.tsx --no-run --output out.js",
    "Compile a pattern, storing the translated and bundled JavaScript to out.js without evaluating.",
  )
  .example(
    "ct dev ./pattern.tsx --no-check",
    "Compile and evaluate pattern without typechecking.",
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
  .option(
    "--main-export <export:string>",
    'Named export from entry for recipe definition. Defaults to "default".',
  )
  .option(
    "--verbose-errors",
    "Show original TypeScript error messages in addition to simplified hints.",
  )
  .option(
    "--pattern-json",
    "Print the evaluated pattern export as JSON.",
  )
  .arguments("<files...:string>")
  .action(async (options, ...files) => {
    let hasError = false;

    for (const file of files) {
      const mainPath = isAbsolute(file) ? file : join(Deno.cwd(), file);

      try {
        const { main: exports } = await process({
          main: mainPath,
          rootPath: Deno.cwd(),
          check: options.check,
          run: options.run,
          output: files.length === 1 ? options.output : undefined,
          filename: options.filename,
          showTransformed: options.showTransformed,
          mainExport: options.mainExport,
          verboseErrors: options.verboseErrors,
        });
        // Only print JSON output when --pattern-json is used
        // (and not when --show-transformed is used, as that already prints to stdout)
        if (options.patternJson && !options.showTransformed && exports) {
          // Select the export to render. If no --main-export specified, use "default".
          // This mirrors the logic in Engine.run() which uses program.mainExport ?? "default"
          const exportName = options.mainExport ?? "default";
          const mainExport = exportName in exports
            ? exports[exportName]
            : exports;
          try {
            // Stringify before rendering, as the exported
            // recipe is a function with extra properties via Object.assign
            render(JSON.stringify(mainExport, null, 2));
          } catch (_) {
            if (
              isRecord(mainExport) && typeof mainExport.toString === "function"
            ) {
              render(mainExport.toString());
            } else {
              throw new Error("Main export not serializable.");
            }
          }
        }
      } catch (error) {
        hasError = true;
        // Re-throw for single file, continue for multiple files
        if (files.length === 1) {
          throw error;
        }
        console.error(error);
      }
    }

    if (hasError) {
      Deno.exit(1);
    }
  });
