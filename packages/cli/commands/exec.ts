import { Command } from "@cliffy/command";
import { executeMountedCallableFile } from "../lib/exec.ts";
import { cliText } from "../lib/cli-name.ts";
import { addressArgument } from "../lib/callable.ts";
import { invocationJson } from "./piece.ts";
import {
  type CellSelection,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import type { ExecutedMountedCallableFile } from "../lib/exec.ts";

/** The `cf exec` flags cliffy parses before the mounted file. Everything
 * after it belongs to the callable's own schema-derived interface. */
export interface ExecCommandOptions {
  filter?: string;
  select?: string;
  schema?: string;
}

/**
 * What `cf exec` writes, and where.
 *
 * **stdout carries the machine surface, and only it.** A tool's is its result
 * — the same bytes `cf piece call` prints for the same tool, now shaped by
 * whatever the caller selected. A handler's is the Invocation JSON its
 * handling settled to, which is the envelope `cf piece call` already declares:
 * `cf exec` reaches a verb through a filesystem mount rather than through a
 * piece address, and that is the whole of the difference between them.
 *
 * **The result cell's address goes to stderr, written the way an address
 * argument is written.** The prose form it replaces — `<id> (space <space>,
 * scope <scope>)` — named the same three parts in a spelling no command
 * accepts, so a caller holding it had to take it apart before the next
 * command would read it. `addressArgument` is the form `--piece` parses, and
 * the line names the command that takes it.
 *
 * Extracted from the action body so it is unit-coverable: command action
 * bodies never execute under the unit suite (docs/development/COVERAGE.md).
 */
export function renderExecOutcome(
  result: ExecutedMountedCallableFile,
  deps: {
    write?: (text: string) => void;
    writeError?: (text: string) => void;
  } = {},
): void {
  const write = deps.write ?? console.log;
  const writeError = deps.writeError ?? console.error;
  if (result.helpText) {
    write(result.helpText);
    return;
  }
  if (result.outputText) {
    write(result.outputText);
    if (result.resultRef) {
      writeError(
        `Tool result cell: ${
          addressArgument(result.resultRef)
        } (read it back with \`cf piece get --piece ${
          addressArgument(result.resultRef)
        }\`)`,
      );
    }
    return;
  }
  if (result.invocation) {
    write(JSON.stringify(invocationJson(result.invocation), null, 2));
  }
}

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
  .example(
    cliText(
      "cf exec --select id,title /tmp/cf/home/pieces/notes/result/search.tool --query milk",
    ),
    "Project the result to selected fields (read options precede the file).",
  )
  .option(
    "--filter <predicate:string>",
    "Filter an array with a jq-inspired predicate (before the mounted file)",
  )
  .option(
    "--select <fields:string>",
    "Project output to comma-separated field paths (before the mounted " +
      "file); a trailing @ asks for a position's address",
  )
  .option(
    "--schema <schema:string>",
    "Project output with an inline JSON Schema, @file, or the --select " +
      "field list (before the mounted file)",
    // Both flags carry the one projection, so a command naming both has not
    // said which shape it wants. Refuse before the call rather than pick.
    { conflicts: ["select"] },
  )
  .stopEarly()
  .arguments("<mountedFile:string> [tail...:string]")
  .action(async (options: ExecCommandOptions, mountedFile, ...tail) => {
    try {
      // Read before anything is resolved or dispatched: a malformed selection
      // is a fact about the flags, and reporting it here costs no mount lookup
      // and runs no verb.
      const selection: CellSelection | undefined =
        await parseCellSelectionOptions(options);
      const result = await executeMountedCallableFile(
        mountedFile,
        tail,
        {},
        selection === undefined ? {} : { selection },
      );
      renderExecOutcome(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      Deno.exit(1);
    }
  });
