import { Command } from "@cliffy/command";
import { executeMountedCallableFile } from "../lib/exec.ts";
import { cliText } from "../lib/cli-name.ts";
import { addressArgument, type InvocationPhase } from "../lib/callable.ts";
import {
  exitPieceCallFailure,
  exitWithDataError,
  invocationJson,
  invocationPhaseReporter,
} from "./piece.ts";
import { newSessionId } from "../lib/session.ts";
import {
  type CellSelection,
  CellSelectionError,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import type { ExecutedMountedCallableFile } from "../lib/exec.ts";

/**
 * `cf exec` runs no verbose in-flight span, so the failure exit it shares with
 * `cf piece call` is handed a span that closes to nothing. The exit's own
 * contract is what is being reused here — the message, the id and the phase —
 * and that part is span-independent.
 */
const NO_SPAN = { finish: () => {} };

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
 * **The result cell's address goes to stderr, written the way the next command
 * takes it.** An address has three parts, and the line spells all three where
 * that command wants them: `addressArgument` renders id and scope as the one
 * token `--piece` parses, and the space rides its own `--space` flag, because
 * that is where `cf piece get` reads it from. Naming the space is not
 * decoration — `cf exec` takes its space from the mount, while `cf piece get`
 * falls back to whatever space the caller has configured, so a line that
 * omitted it would suggest a command that reads a different cell.
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
      const address = addressArgument(result.resultRef);
      writeError(
        `Tool result cell: ${address} (read it back with \`cf piece get ` +
          `--space ${result.resultRef.space} --piece ${address}\`)`,
      );
    }
    return;
  }
  if (result.invocation) {
    write(JSON.stringify(invocationJson(result.invocation), null, 2));
  }
}

/**
 * The failure exit for `cf exec`.
 *
 * Before `dispatched` there is no invocation worth naming: the pair minted for
 * this call was never spent and never announced, and a tool never passes
 * through the handler phases at all — so the report is the message alone, the
 * same one a missing mount or an unreadable callable has always printed.
 *
 * From `dispatched` onward the handling may have committed, and the report
 * becomes the one `cf piece call` makes: the message, then the id beside the
 * furthest phase reached. That phase is the difference between a retry that
 * deduplicates and one that commits a second time — and `cf exec` accepts no
 * `--invocation`, so a retry can only be a fresh pair. Saying so is what lets
 * a caller decide rather than guess. The session completing the pair is
 * already on stderr, announced at dispatch.
 *
 * A named export rather than catch-block prose because the action body only
 * runs under Cliffy and is unreachable from a unit test; the seams let a test
 * observe the exact exit contract, and the action's catch calls THIS function.
 */
export function exitExecFailure(
  error: unknown,
  invocationId: string,
  phase: InvocationPhase,
  deps?: {
    printError?: (message: string) => void;
    render?: (text: string) => void;
    exit?: (code: number) => never;
  },
): never {
  if (phase !== "initial_sync") {
    return exitPieceCallFailure(NO_SPAN, error, invocationId, phase, deps);
  }
  const printError = deps?.printError ?? console.error;
  const exit = deps?.exit ?? Deno.exit;
  printError(error instanceof Error ? error.message : String(error));
  return exit(1);
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
    // Read before anything is resolved or dispatched, and OUTSIDE the failure
    // wrapper below: a malformed selection is a fact about the flags, it costs
    // no mount lookup and runs no verb, and reporting it through the wrapper
    // would name an invocation and a phase to retry from for a call that was
    // never made. A selection that fails against a RESULT does sit inside the
    // wrapper, and does name one.
    let selection: CellSelection | undefined;
    try {
      selection = await parseCellSelectionOptions(options);
    } catch (error) {
      if (error instanceof CellSelectionError) {
        exitWithDataError({ message: error.message });
      }
      throw error;
    }

    // Minted here rather than inside the dispatch so this frame can both
    // announce it and name it again if the call fails. `cf exec` accepts no
    // `--invocation`, so every call is a fresh pair; that makes announcing it
    // the ONLY way a caller ever learns what to retry under.
    const invocation = { id: crypto.randomUUID(), session: newSessionId() };
    let phase: InvocationPhase = "initial_sync";
    const onPhase = invocationPhaseReporter(
      invocation,
      (next) => phase = next,
      undefined,
      Boolean(Deno.env.get("CF_TEST_ANNOUNCE_INVOCATION_PHASES")),
    );

    try {
      const result = await executeMountedCallableFile(
        mountedFile,
        tail,
        { onPhase },
        {
          invocation,
          ...(selection === undefined ? {} : { selection }),
        },
      );
      renderExecOutcome(result);
    } catch (error) {
      exitExecFailure(error, invocation.id, phase);
    }
  });
