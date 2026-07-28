/**
 * `cf completion` — shell completion scripts and the callback that feeds them.
 *
 * Cliffy ships a `CompletionsCommand`, but its dynamic hook passes the
 * completion callback only `(command, parent)`: no cursor word, and no access
 * to the options already typed. That is enough for a static command tree and
 * nothing more — it cannot answer "the callables of the piece named by the
 * `--piece` on this line". Since the values worth completing in cf are exactly
 * those context-dependent ones (piece ids, callables, cell paths), this command
 * emits its own thin shell functions that forward the whole line instead.
 */

import { Command } from "@cliffy/command";
import { cliName } from "../lib/cli-name.ts";
import {
  bashCompletionScript,
  zshCompletionScript,
} from "../lib/completion/script.ts";
import { complete, tokenizeLine } from "../lib/completion/mod.ts";

const description = `Generate shell completion scripts.

Completion covers the command tree and, when the line names a reachable space,
live values: piece ids annotated with their names, a piece's callables, cell
paths walked a segment at a time, and locally known spaces.

Live values need an identity and api-url, taken from the line being typed
(-i/-a/-u) or from CF_IDENTITY/CF_API_URL. Without them the command tree still
completes.

These also complete "deno task ${cliName()} ..." — see DENO TASK below.

INSTALL (zsh), in ~/.zshrc after compinit:
  source <(${cliName()} completion zsh)

INSTALL (bash), in ~/.bashrc:
  source <(${cliName()} completion bash)
  # or system-wide:
  ${cliName()} completion bash > /usr/local/etc/bash_completion.d/${cliName()}

DENO TASK:
  The scripts bind 'deno' as well as '${cliName()}', so "deno task ${cliName()} ..."
  completes too. A deno line that is not a ${cliName()} invocation is handed back
  to deno's own completion. Use --no-deno-task to bind only ${cliName()}.

  This binding needs the script evaluated, not just autoloadable. Installing
  the zsh script into fpath instead ('completion zsh > "\${fpath[1]}/_${cliName()}"')
  completes ${cliName()} itself, but the deno binding waits until ${cliName()} completes
  once. To keep that layout, add after compinit:
    _${cliName()}_deno_previous="\${_comps[deno]:-}"
    compdef _${cliName()} deno

The scripts forward the command line to '${cliName()} completion complete',
so they keep working as commands are added — reinstall only if this CLI moves.`;

/**
 * The callback the installed shell function invokes on every Tab.
 *
 * Accepts either shape of input: zsh forwards its own tokenized `words` with
 * `--cword`, bash forwards the raw buffer with `--line`/`--point` (its own
 * word-splitting mangles `:` and `=`, which cf values are full of).
 */
const completeCommand = new Command()
  .description("Internal: emit completion candidates for a command line.")
  .option("--shell <shell:string>", "Shell requesting completion.", {
    default: "bash",
  })
  .option("--cword <index:integer>", "Index of the word under the cursor.")
  .option("--line <line:string>", "Raw command line, for shells without words.")
  .option("--point <point:integer>", "Cursor offset into --line.")
  .arguments("[words...:string]")
  .noGlobals()
  .action(async (options, ...words: string[]) => {
    const shell = options.shell === "zsh" ? "zsh" : "bash";

    let resolved: { words: string[]; cword: number };
    if (options.line !== undefined) {
      resolved = tokenizeLine(
        options.line,
        options.point ?? options.line.length,
      );
    } else {
      resolved = {
        words: [...words],
        cword: options.cword ?? Math.max(0, words.length - 1),
      };
    }

    // Resolved lazily: importing the root command pulls in the whole command
    // tree, and doing it inside the guard keeps a failure silent.
    const { main } = await import("./main.ts");

    try {
      const lines = await complete(
        main,
        resolved.words,
        resolved.cword,
        shell,
      );
      if (lines.length > 0) console.log(lines.join("\n"));
    } catch {
      // A completion request runs mid-keystroke. Anything unexpected yields no
      // candidates rather than text pasted into the user's command line.
    }
  });

export const completion = new Command()
  .description(description)
  .default("help")
  .command(
    "bash",
    new Command()
      .description("Output the bash completion script.")
      .option(
        "--no-deno-task",
        `Do not also complete "deno task ${cliName()} ...".`,
      )
      .noGlobals()
      .action((options) =>
        console.log(
          bashCompletionScript(cliName(), { denoTask: options.denoTask }),
        )
      ),
  )
  .command(
    "zsh",
    new Command()
      .description("Output the zsh completion script.")
      .option(
        "--no-deno-task",
        `Do not also complete "deno task ${cliName()} ...".`,
      )
      .noGlobals()
      .action((options) =>
        console.log(
          zshCompletionScript(cliName(), { denoTask: options.denoTask }),
        )
      ),
  )
  .command("complete", completeCommand.hidden());
