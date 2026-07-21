import { Command } from "@cliffy/command";
import { type ColorWhen, ViewError, viewMain } from "../lib/view/mod.ts";
import { cliText } from "../lib/cli-name.ts";

const description = cliText(
  `Interactive, syntax-aware pager for transformed patterns and diffs.

A less-like viewer for the dense output of '--show-transformed'. It parses the
text with the same TypeScript parser the transformer uses, so blocks, closures,
schemas, type positions and Common Fabric builders (pattern/lift/handler/…) are
coloured exactly as the compiler sees them. The text shown is verbatim — colour
only.

Unified diffs are detected automatically: piping 'git diff' in gives added and
removed lines their tints, full syntax colour, a structure tree of the code
each hunk touches, and the semantic features (inferred types, go-to-definition)
answered against the CURRENT state of the workspace files the diff names.

COMMON USAGE:
  cf check ./pattern.tsx --show-transformed --no-run | cf view
  git diff origin/main | cf view        # diff mode
  cf view transformed.ts                # view a saved file
  cf check ./p.tsx --show-transformed --no-run | cf view --plain | bat

KEYS (press ? in the viewer for the full list):
  ↑/↓ k/j scroll · ←/→ h/l pan · Space/b page · g/G top/bottom · / search
  structure tree: w/s sibling · a/d parent/child · Tab/⇧Tab depth-first
  Enter info card · in it: ↑/↓ pick a reference · Enter opens it · z reveals it
  t look up a definition · # line numbers · \\ wrap long lines · q quit

When stdout is not a terminal (piped/redirected) it prints the colourised text
and exits, like less.`,
);

export const view = new Command()
  .name("view")
  .description(description)
  .example(
    cliText(`cf check ./pattern.tsx --show-transformed --no-run | cf view`),
    "Pipe transformed output into the interactive viewer.",
  )
  .example(
    cliText(`git diff origin/main | cf view`),
    "View a diff with syntax colour, structure navigation and types.",
  )
  .example(
    cliText(`cf view transformed.ts`),
    "Open a previously saved transformed file.",
  )
  .option(
    "--color <when:string>",
    "Colourise: always | auto | never (auto = when stdout is a TTY).",
    { default: "auto" },
  )
  .option(
    "--plain",
    "Do not launch the interactive pager; print colourised text and exit.",
  )
  .option(
    "-n, --line-numbers",
    "Show line numbers (toggle with # in the viewer).",
  )
  .option(
    "--diff",
    "Treat the input as a unified diff, overriding auto-detection.",
  )
  .option(
    "--no-diff",
    "Treat the input as source even if it looks like a diff.",
  )
  .arguments("[file:string]")
  .action(
    async (
      options: {
        color?: string;
        plain?: boolean;
        lineNumbers?: boolean;
        diff?: boolean;
      },
      file?: string,
    ) => {
      try {
        const when = (options.color ?? "auto") as ColorWhen;
        if (when !== "always" && when !== "auto" && when !== "never") {
          throw new ViewError(
            `--color must be always, auto, or never (got "${when}")`,
          );
        }
        await viewMain({
          color: when,
          plain: options.plain ?? false,
          lineNumbers: options.lineNumbers ?? false,
          file,
          diff: options.diff,
        });
      } catch (error) {
        // Expected, user-facing conditions print plainly without a stack trace.
        if (error instanceof ViewError) {
          console.error(error.message);
          Deno.exit(1);
        }
        throw error;
      }
    },
  );
