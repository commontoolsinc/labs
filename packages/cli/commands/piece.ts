import { Table } from "@cliffy/table";
import { Command, ValidationError } from "@cliffy/command";
import { VerbInputValidationError } from "../lib/callable.ts";
import {
  applyPieceInput,
  checkPiecePattern,
  type EntryConfig,
  executePieceCallable,
  formatViewTree,
  generateSpaceMap,
  getCellValue,
  getPieceView,
  inspectPiece,
  linkPieces,
  linkSqliteDiskSource,
  LinkValidationError,
  listPieceCallables,
  listPieces,
  MapFormat,
  newPiece,
  partitionVerbListing,
  PieceConfig,
  PieceResultProjectionError,
  PieceVerbReadError,
  recreateSpaceRootPattern,
  removePiece,
  resetHomePattern,
  savePiecePattern,
  searchPieces,
  setCellValue,
  setHomePattern,
  setPiecePattern,
  setPieceSlug,
  SpaceConfig,
  stepPiece,
} from "../lib/piece.ts";
import type { ExecutedPieceCallable } from "../lib/piece.ts";
import type { PatternCompatibilityReport } from "@commonfabric/piece/ops";
import type {
  InvocationIdentity,
  InvocationOutcome,
  InvocationPhase,
} from "../lib/callable.ts";
import { newSessionId } from "../lib/session.ts";
import { renderPiece } from "../lib/piece-render.ts";
import { parseSqliteSource } from "../lib/sqlite-source.ts";
import { render, safeStringify } from "../lib/render.ts";
import { decode } from "@commonfabric/utils/encoding";
import { cliText } from "../lib/cli-name.ts";
import { absPath } from "../lib/utils.ts";
import type { CellScope } from "@commonfabric/api";
import { parseCellPath } from "@commonfabric/runner";
import { UI } from "@commonfabric/runner";
import ports from "@commonfabric/ports" with { type: "json" };
import type { PiecePatternRef } from "@commonfabric/piece/ops";
import { reservesStdoutForCommandOutput } from "../lib/json-output.ts";
import {
  type CellSelection,
  CellSelectionError,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";

// Hint system: print helpful next-step suggestions after operations
let quietMode = false;

export function setQuietMode(quiet: boolean) {
  quietMode = quiet;
}

function hint(message: string, showQuietTip = true) {
  if (!quietMode) {
    const quietTip = showQuietTip ? "\n\n(Use --quiet to suppress hints)" : "";
    console.error(`\n${message}${quietTip}`);
  }
}

export function normalizeApiUrl(apiUrl: string): string {
  const parsed = new URL(apiUrl);
  const normalized = new URL(parsed);
  const basePath = parsed.pathname.split("/").filter(Boolean).join("/");
  normalized.pathname = basePath ? `/${basePath}` : "/";
  normalized.search = "";
  normalized.hash = "";
  const href = normalized.toString();
  return basePath ? href : href.slice(0, -1);
}

function summarizeForDisplay(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return `[Array(${value.length})]`;
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    if (v === null || v === undefined) out[k] = v;
    else if (typeof v !== "object") out[k] = v;
    else if (Array.isArray(v)) out[k] = `[Array(${v.length})]`;
    else out[k] = "[Object]";
  }
  return out;
}

export function formatPatternRef(
  patternRef: PiecePatternRef | undefined,
): string {
  if (patternRef === undefined) return "<unknown>";
  if (patternRef.source.repository !== undefined) {
    return patternRef.source.entry === undefined
      ? patternRef.source.repository
      : `${patternRef.source.repository}#${patternRef.source.entry}`;
  }
  return patternRef.source.origin ?? patternRef.source.entry ??
    patternRef.source.ref;
}

export function formatPatternIdentity(
  patternRef: PiecePatternRef | undefined,
): string {
  return patternRef === undefined
    ? "<unknown>"
    : `cf:module/${patternRef.identity}#${patternRef.symbol}`;
}

export function renderPieceSummaries(
  pieces: Array<{
    id: string;
    name?: string;
    patternRef?: PiecePatternRef;
    error?: string;
  }>,
  json: boolean,
): void {
  if (json) {
    render(
      pieces.map((piece) => ({
        id: piece.id,
        name: piece.name ?? null,
        patternRef: piece.patternRef ?? null,
      })),
      { json: true },
    );
    return;
  }

  const rows = [
    ["ID", "NAME", "PATTERN"],
    ...pieces.map((piece) => [
      piece.id,
      piece.error ? `<error: ${piece.error}>` : (piece.name ?? "<unnamed>"),
      piece.error ? "" : formatPatternRef(piece.patternRef),
    ]),
  ];
  if (rows.length > 1) render(Table.from(rows).toString());
}

export function localPatternEntry(
  mainPath: string,
  options: {
    mainExport?: string;
    repository?: string;
    root?: string;
    test?: string[];
  },
): EntryConfig {
  return {
    mainPath: absPath(mainPath),
    mainExport: options.mainExport,
    repository: options.repository,
    rootPath: options.root ? absPath(options.root) : undefined,
    testPaths: options.test?.map((path) => absPath(path)),
  };
}

/**
 * A `piece get` failure caused by a data condition rather than bad arguments:
 * a path that doesn't resolve, a result schema that can't project stored data
 * (PieceResultProjectionError), a filter/projection that doesn't fit the
 * selected value (CellSelectionError), or a path that lands on a verb
 * (PieceVerbReadError — the read-path guard's redirect at `cf piece call`).
 * Reported as a plain error on stderr with exit 1, never as a Cliffy
 * ValidationError (which would dump the usage screen and read as an arg-parse
 * failure).
 */
export function isPieceGetDataError(error: unknown): error is Error {
  return error instanceof PieceResultProjectionError ||
    error instanceof CellSelectionError ||
    error instanceof PieceVerbReadError ||
    (error instanceof Error &&
      error.message.startsWith("Cannot access path"));
}

/**
 * Build the stderr report for a `piece get` failure. Returns null when the
 * error is not a data error (the caller should rethrow). `message` is the
 * one-line error; `hint` is an optional next-step tip. A projection error
 * already carries its own `--step` guidance, selection errors stand alone,
 * a verb refusal already carries its `cf piece call` redirect, and an
 * input-mode read has nothing more to suggest — only a result-mode
 * unresolved path gets the `--input` tip.
 */
export function pieceGetDataErrorReport(
  error: unknown,
  opts: { input?: boolean; piece?: string },
): { message: string; hint?: string } | null {
  if (!isPieceGetDataError(error)) return null;
  if (
    error instanceof PieceResultProjectionError ||
    error instanceof CellSelectionError ||
    error instanceof PieceVerbReadError ||
    opts.input
  ) {
    return { message: error.message };
  }
  return {
    message: error.message,
    hint: cliText(
      `TIP: The path was read from the result cell. If the field is an input, retry with --input, or run 'cf piece inspect --piece ${opts.piece} ...' to see both cells.`,
    ),
  };
}

/**
 * Build the stderr report for a `piece link` validation failure. Returns null
 * when the error is not a LinkValidationError (the caller should rethrow).
 * Link validation fails on data conditions — a source/target piece or path
 * that doesn't exist, read over the network — so it reports like `piece get`'s
 * unresolved-path data error rather than as a Cliffy usage error.
 */
export function pieceLinkDataErrorReport(
  error: unknown,
  opts: { sourcePieceId: string; targetPieceId: string },
): { message: string; hint: string } | null {
  if (!(error instanceof LinkValidationError)) return null;
  return {
    message: error.message,
    hint: cliText(
      `TIP: Run 'cf piece inspect --piece ${opts.sourcePieceId} ...' and '--piece ${opts.targetPieceId} ...' to see the fields each piece actually has.`,
    ),
  };
}

/**
 * Build the stderr report for a `piece call` payload rejection. Returns null
 * when the error is not a VerbInputValidationError (the caller should
 * rethrow). The flags parsed fine and the piece resolved — the values simply
 * do not fit the verb — so it reports like the other data errors rather than
 * as a usage failure, and points at the listing that shows the shape it wanted.
 */
export function verbInputErrorReport(
  error: unknown,
  opts: { piece: string },
): { message: string; hint: string } | null {
  if (!(error instanceof VerbInputValidationError)) return null;
  return {
    message: error.message,
    hint: cliText(
      `TIP: Run 'cf piece verbs --piece ${opts.piece} --json' to see each verb's expected input.`,
    ),
  };
}

/**
 * Print a data-error report — message plus optional hint — to stderr and exit
 * 1. The single exit path for the `piece get` / `piece link` data errors
 * above. The `deps` seam lets unit tests observe the wiring without a real
 * process exit; runtime callers use the defaults.
 */
export function exitWithDataError(
  report: { message: string; hint?: string },
  deps?: {
    printError?: (message: string) => void;
    printHint?: (message: string) => void;
    exit?: (code: number) => never;
  },
): never {
  const printError = deps?.printError ?? console.error;
  const printHint = deps?.printHint ?? hint;
  const exit = deps?.exit ?? Deno.exit;
  printError(report.message);
  if (report.hint) printHint(report.hint);
  return exit(1);
}

/**
 * Turn a failed `piece call` into its stderr report, or re-throw.
 *
 * A named function rather than an inline `.catch` in the command action: the
 * action body only ever runs under Cliffy, so anything written there is
 * unreachable from a unit test. The `deps` seam is `exitWithDataError`'s,
 * threaded so a test can observe the report without a real process exit.
 *
 * `observer` is the call's phase observer: this exit bypasses the action's
 * catch (it terminates the process from inside the promise chain), so the
 * verbose in-flight span must be closed HERE — otherwise a pre-dispatch
 * payload rejection under --verbose would leave the initial_sync span
 * dangling with no failure timing. A rethrown error is closed by the
 * action's own failure exit instead.
 */
export function reportVerbInputErrorOrRethrow(
  error: unknown,
  piece: string | undefined,
  deps?: Parameters<typeof exitWithDataError>[1],
  observer?: { finish: (end?: "settled" | "failed") => void },
): never {
  const report = verbInputErrorReport(error, { piece: piece ?? "<piece>" });
  if (report) {
    observer?.finish("failed");
    exitWithDataError(report, deps);
  }
  throw error;
}

/**
 * The failure exit for `cf piece call`: closes the verbose in-flight span as
 * `failed` (idempotent — a span already closed elsewhere stays closed),
 * rethrows Cliffy validation errors so usage failures still render the usage
 * screen — with their span closed first — and reports everything else as the
 * failure message plus the invocation id beside the furthest observed phase,
 * the retry key, before exiting 1. A named export rather than catch-block
 * prose because the action body only runs under Cliffy and is unreachable
 * from a unit test; the seams let a test observe the exact exit contract.
 */
export function exitPieceCallFailure(
  observer: { finish: (end?: "settled" | "failed") => void },
  error: unknown,
  invocationId: string,
  phase: InvocationPhase,
  deps?: {
    printError?: (message: string) => void;
    exit?: (code: number) => never;
  },
): never {
  observer.finish("failed");
  if (error instanceof ValidationError) {
    throw error;
  }
  const printError = deps?.printError ?? console.error;
  const exit = deps?.exit ?? Deno.exit;
  printError(error instanceof Error ? error.message : String(error));
  // Where the invocation stopped decides retry semantics: anything at or
  // past "dispatched" retries SAFELY ONLY with this same id (same-id
  // retries deduplicate; a fresh id would re-execute).
  printError(`invocation: ${invocationId} phase: ${phase}`);
  return exit(1);
}

export function pieceCallRawArgs(
  tail: string[],
  literalArgs: string[],
): string[] {
  if (literalArgs.length > 0) {
    // Schema-derived flags after `--`. A payload token before `--` (inline
    // JSON or the `-` stdin sentinel) would be silently dropped here, so
    // reject the combination loudly instead — the same no-op this family of
    // fixes is stamping out. Mirrors the `tail.length > 1` rejection below.
    if (tail.length > 0) {
      throw new ValidationError(
        'Callable arguments cannot appear on both sides of "--". ' +
          'Pass either a payload argument (inline JSON or "-" for stdin) ' +
          'or schema-derived flags after "--", not both.',
      );
    }
    return literalArgs;
  }

  if (tail.length === 0) {
    return [];
  }

  if (tail[0] === "--help") {
    if (tail.length === 1) {
      return tail;
    }
    if (tail.length === 2 && tail[1] === "--json") {
      return tail;
    }
    throw new ValidationError(
      'Use "-- --help <value>" to set an input field named "help".',
    );
  }

  // Explicit two-token stdin sentinels (a JSON/value flag plus "-"), forwarded
  // to the exec layer so the friendly surface matches `cf exec` and the bare
  // "-" form. Without this they'd hit the multi-argument rejection below.
  if (
    tail.length === 2 && tail[1] === "-" &&
    (tail[0] === "--json" || tail[0] === "--json-file" ||
      tail[0] === "--value-file")
  ) {
    return [tail[0], "-"];
  }

  if (tail[0] === "--json") {
    return tail;
  }

  if (tail.length > 1) {
    throw new ValidationError(
      'Use a single inline JSON argument or "--" before schema-derived flags.',
    );
  }

  // "-" is the conventional stdin sentinel; route it through the existing
  // --json-file stdin path so empty stdin still fails loudly.
  if (tail[0] === "-") {
    return ["--json-file", "-"];
  }

  return ["--json", tail[0]];
}

export function pieceCallInvocation(
  tail: string[],
  literalArgs: string[],
): { rawArgs: string[]; jsonOutput: boolean } {
  const rawArgs = pieceCallRawArgs(tail, literalArgs);
  const argumentOffset = rawArgs[0] === "invoke" || rawArgs[0] === "run"
    ? 1
    : 0;
  const firstArgument = rawArgs[argumentOffset];
  const jsonOutput = firstArgument === "--json" ||
    firstArgument === "--json-file" ||
    (firstArgument === "--help" &&
      rawArgs.length === argumentOffset + 2 &&
      rawArgs[argumentOffset + 1] === "--json");
  return { rawArgs, jsonOutput };
}

/**
 * Resolve what names a handler call's invocation: the id for this dispatch
 * and the session it was chosen within (`CF_INVOCATION_SESSION`, or
 * `--invocation-session`). Both reach the durable event id the handling's
 * receipt is filed under, so a later call settles on that receipt only by
 * naming the same pair (verb contract WS-D).
 *
 * A caller that names neither gets both minted for this one request. The id
 * is random, so it names an outcome nothing else will ask for; scoping it to
 * a session minted alongside it costs such a call nothing, and keeps every
 * call deriving its address the one way.
 *
 * A caller that names an id but no session is refused. Naming an id asks for
 * an outcome that is addressable and replayable, and a session minted per
 * request would put that same id on a different outcome next time — so the
 * request cannot be honored as it was made. Saying so beats accepting it and
 * letting the caller find out at the retry it was preparing for, when the
 * verb runs a second time.
 *
 * A blank id or session is rejected rather than passed down: either would
 * read as "the caller named one" while carrying nothing that tells two
 * deliveries apart.
 */
export function resolveInvocationIdentity(
  rawInvocation: string | undefined,
  rawSession: string | undefined,
  mintInvocationId: () => string = () => crypto.randomUUID(),
  mintSession: () => string = newSessionId,
): InvocationIdentity {
  if (rawInvocation !== undefined && !rawInvocation.trim()) {
    throw new ValidationError("--invocation requires a non-blank id");
  }
  if (rawSession !== undefined && !rawSession.trim()) {
    throw new ValidationError("--invocation-session requires a non-blank id");
  }
  if (rawSession === undefined) {
    if (rawInvocation !== undefined) {
      throw new ValidationError(
        "--invocation names an id to replay, and an id is replayable only " +
          "within the session it was chosen in. Mint a session with " +
          "`cf invocation-session new` and set `CF_INVOCATION_SESSION`, or " +
          "pass it as `--invocation-session <id>`.",
      );
    }
    return { id: mintInvocationId(), session: mintSession() };
  }
  return { id: rawInvocation ?? mintInvocationId(), session: rawSession };
}

/**
 * Build the phase observer for a handler invocation. Its whole job is to put
 * the invocation id on stderr at the moment the event is about to dispatch —
 * BEFORE any network work — so a caller whose process dies past that line
 * still holds the exact id to retry with, and the retry deduplicates instead
 * of executing a second time. Announcing once matters: a caller scraping
 * stderr for its id should not have to decide which of several to trust.
 *
 * The id is half of what a retry names: it deduplicates only under the session
 * it was chosen in. So the session is announced beside it, on its own line —
 * a caller that named no session was minted one for this call, and without
 * reading it here would hold an id that names nothing it can return to.
 *
 * Two lines rather than one because `invocation: <id> phase: <phase>` below is
 * a parsed shape: appending to the id line would change what a scenario
 * blocking on a phase reads.
 *
 * `announcePhases` is a test-harness hook (reached via the
 * `CF_TEST_ANNOUNCE_INVOCATION_PHASES` env var at the call site): every phase
 * advance is additionally announced as `invocation: <id> phase: <phase>` —
 * the shape failure exits already print. Integration scenarios that must act
 * inside a specific window block on a phase line instead of racing a clock:
 * the dropped-response fixture kills its call only after reading
 * `phase: committed`, which the observer emits only once the handling's
 * durable commit has been acknowledged. Off by default, so normal output is
 * byte-identical with the hook absent.
 */
export function invocationPhaseReporter(
  invocation: InvocationIdentity,
  onAdvance: (phase: InvocationPhase) => void,
  announce: (message: string) => void = console.error,
  announcePhases = false,
): (phase: InvocationPhase) => void {
  let announced = false;
  return (next) => {
    if (next === "dispatched" && !announced) {
      announced = true;
      announce(`invocation: ${invocation.id}`);
      announce(`session: ${invocation.session}`);
    }
    if (announcePhases) {
      announce(`invocation: ${invocation.id} phase: ${next}`);
    }
    onAdvance(next);
  };
}

/**
 * Phase observer for `cf piece call`: always advances the furthest-phase
 * tracker the failure report prints; under --verbose it also streams one
 * wall-clock span per observed phase transition (verb contract WS-D, phase
 * timings). Spans are bounded by the phases the `onPhase` callback already
 * observes — initial sync up to dispatch, the dispatched handler run up to
 * its transaction-local commit acknowledgement, the receipt classification,
 * and the receipt readback up to settlement — because those boundaries are
 * what the invocation actually reports; nothing new is instrumented inside
 * the runner. Every line goes to stderr so stdout stays exactly the settled
 * Invocation JSON an agent parses, and lines stream as transitions happen so
 * a failure exit keeps every span observed before the failure — `finish`
 * closes the in-flight span with the outcome that ended it: `settled`,
 * `failed`, or `detached` for a `--no-wait` exit that stopped at the commit
 * acknowledgement and skipped the readback.
 */
export function pieceCallPhaseObserver(
  verbose: boolean,
  onAdvance: (phase: InvocationPhase) => void,
  emit: (line: string) => void = console.error,
  now: () => number = () => performance.now(),
): {
  onPhase: (phase: InvocationPhase) => void;
  finish: (end?: "settled" | "failed" | "detached") => void;
} {
  if (!verbose) {
    return { onPhase: onAdvance, finish: () => {} };
  }
  let current: InvocationPhase = "initial_sync";
  let spanStart = now();
  let finished = false;
  const close = (next: string) => {
    emit(`timing: ${current} → ${next} ${(now() - spanStart).toFixed(1)}ms`);
  };
  return {
    onPhase: (next) => {
      close(next);
      current = next;
      spanStart = now();
      onAdvance(next);
    },
    finish: (end = "settled") => {
      if (finished) return;
      finished = true;
      close(end);
    },
  };
}

/**
 * The success tail of `cf piece call`, extracted from the command action so
 * it is unit-coverable — command action bodies never execute under the unit
 * suite, the same convention that keeps `cf test` out of its action body
 * (docs/development/COVERAGE.md). Help output returns BEFORE the observer
 * finishes: no invocation ran, so there is no span to close.
 */
export function renderPieceCallOutcome(
  observer: { finish: (end?: "settled" | "failed" | "detached") => void },
  result: ExecutedPieceCallable,
  callableName: string,
  piece: string,
  deps: {
    render?: (text: string) => void;
    hint?: (text: string, prefix?: boolean) => void;
    printError?: (text: string) => void;
  } = {},
  opts: { detached?: boolean; invocation?: InvocationIdentity } = {},
): void {
  const renderOut = deps.render ?? render;
  const hintOut = deps.hint ?? hint;
  const printError = deps.printError ?? console.error;
  if (result.helpText) {
    renderOut(result.helpText);
    return;
  }
  observer.finish(opts.detached ? "detached" : undefined);
  if (result.outputText) {
    renderOut(result.outputText);
    if (result.resultRef) {
      // stderr, so stdout stays exactly the tool's JSON result. Routed
      // through hint() DELIBERATELY: under --quiet the ref is suppressed —
      // it is advisory until the invocation protocol carries it in the
      // stdout Invocation JSON (verb contract WS-D), and --quiet callers
      // asked for the bare result.
      const ref = result.resultRef;
      hintOut(
        `Tool result cell: ${ref.id} (space ${ref.space}, scope ${ref.scope})`,
        false,
      );
    }
    return;
  }
  const nextSteps = cliText(`NEXT STEPS:
  → Verify state:  cf piece get --piece ${piece} <path> ...
  → Full inspect:  cf piece inspect --piece ${piece} ...`);
  if (result.invocation) {
    // The machine surface for a handler invocation: stdout carries the
    // Invocation JSON — settled, or stopped at "committed" under --no-wait —
    // prose stays on stderr via hint().
    renderOut(JSON.stringify(invocationJson(result.invocation), null, 2));
    // The address the envelope published, when the runtime wrote a receipt.
    // It leads the detached next steps because it collects the outcome
    // without running the verb again.
    const receiptId = result.invocation.receipt?.id;
    hintOut(
      opts.detached
        ? cliText(
          receiptId === undefined
            // No receipt means receipts are not being written here, and that
            // is exactly the configuration in which a same-id call does NOT
            // deduplicate — it executes AND commits a second time. Offering
            // the replay as a recovery would be offering a duplicate.
            ? `NEXT STEPS:
  → Nothing to collect: this handling wrote no receipt, so the outcome has no address and a call naming the same pair executes and commits AGAIN rather than deduplicating.
  → Verify state:     cf piece get --piece ${piece} <path> ...`
            // The replay names its session through the environment rather
            // than `--invocation-session`, because a session is what keeps an
            // outcome's address out of reach of anyone who can guess a piece,
            // a verb and an id — and an argument is readable in a process
            // listing where an environment variable is not.
            : `NEXT STEPS:
  → Read the outcome: cf piece get --piece ${receiptId} (this call's receipt, an ordinary read — the handler does not run again)
  → Or replay it:     CF_INVOCATION_SESSION=${
              opts.invocation?.session ?? "<session>"
            } cf piece call --piece ${piece} --invocation ${
              opts.invocation?.id ?? "<id>"
            } ${callableName} ... (the commit is durable and the replay loses the race for the receipt, so nothing commits twice — but the handler body RUNS AGAIN, repeating effects outside its transaction, and any write it made into another space)
  → Verify state:     cf piece get --piece ${piece} <path> ...`,
        )
        : nextSteps,
    );
    return;
  }
  const confirmation = `Called handler "${callableName}" on piece ${piece}`;
  if (result.parsed.usedJsonInput) {
    printError(confirmation);
  } else {
    renderOut(confirmation);
  }
  hintOut(nextSteps);
}

/**
 * Shape a settled handler invocation for stdout. This is the wire contract an
 * agent parses, so the optional keys are load-bearing: `deduplicated` appears
 * only when the call collided on an existing receipt, and `result` only when
 * the receipt carried one — a value-less verb omits it rather than reporting
 * `null`, which would be indistinguishable from a verb that returned null.
 * `links` appears only under --show-links: provenance beside the value,
 * never inline in it.
 *
 * `receipt` is the one key that does not depend on a readback or a flag: it
 * is the address of the cell holding this outcome, known at commit, so it
 * rides a `--no-wait` envelope as well as a settled one. It is absent only
 * where the runtime wrote no receipt to address.
 */
export function invocationJson(
  outcome: InvocationOutcome,
): Record<string, unknown> {
  return {
    invocation: outcome.id,
    status: outcome.status,
    ...(outcome.deduplicated ? { deduplicated: true } : {}),
    ...(outcome.receipt !== undefined ? { receipt: outcome.receipt } : {}),
    ...("result" in outcome && outcome.result !== undefined
      ? { result: outcome.result }
      : {}),
    ...(outcome.links !== undefined ? { links: outcome.links } : {}),
  };
}

/** How long `cf piece call` waits for a handler invocation (verb contract
 * WS-F, F3). `settle` is the default: await this handling's commit
 * acknowledgement plus receipt readback, optionally bounded by the caller's
 * patience (`--wait <seconds>`). `commit` (`--no-wait`) awaits the
 * transaction-local commit acknowledgement — the durable point; the handler
 * runs in THIS process, so the acknowledgement is not skippable — and skips
 * only the receipt readback. */
export interface PieceCallWaitControl {
  mode: "settle" | "commit";
  /** Caller-chosen patience bound in seconds (`--wait`). Never set for
   * `commit` — the readback the bound would cover is already skipped. */
  boundSeconds?: number;
}

/** The `cf piece call` flags whose answer needs the receipt readback. */
export interface PieceCallReadbackFlags {
  showLinks?: boolean;
  filter?: string;
  select?: string;
  schema?: string;
}

/**
 * Those flags paired with the spelling a refusal names them by, in the order a
 * caller writes them.
 */
const READBACK_FLAGS: ReadonlyArray<
  [keyof PieceCallReadbackFlags, string]
> = [
  ["showLinks", "--show-links"],
  ["filter", "--filter"],
  ["select", "--select"],
  ["schema", "--schema"],
];

/**
 * Resolve the wait flags into one control. `--await` is the explicit spelling
 * of the default (flag parity, so a script can state its intent), which makes
 * `--await --no-wait` a contradiction rather than a precedence puzzle — it is
 * refused. `--await --wait <s>` is fine: both mean "wait", the bound just
 * names the patience. A non-positive bound is refused: it would spell
 * "don't wait" while claiming to be a wait.
 *
 * `--no-wait` also refuses every flag that shapes or annotates the outcome —
 * `--show-links` and the selection flags. All of them are answered from the
 * receipt a detached exit never reads, so honoring both is impossible;
 * refusing beats silently handing back an unshaped result or dropping the
 * links.
 */
export function resolveWaitControl(
  options:
    & { await?: boolean; wait?: number | boolean }
    & PieceCallReadbackFlags,
): PieceCallWaitControl {
  if (options.wait === false) {
    if (options.await) {
      throw new ValidationError(
        "--await and --no-wait contradict each other; pass one.",
      );
    }
    const named = READBACK_FLAGS
      .filter(([key]) => options[key] !== undefined && options[key] !== false)
      .map(([, flag]) => flag);
    if (named.length > 0) {
      throw new ValidationError(
        `${listFlags(named)} need${named.length === 1 ? "s" : ""} the ` +
          "receipt readback that --no-wait skips; pass one.",
      );
    }
    return { mode: "commit" };
  }
  if (typeof options.wait === "number") {
    if (!Number.isFinite(options.wait) || options.wait <= 0) {
      throw new ValidationError(
        "--wait requires a positive number of seconds",
      );
    }
    return { mode: "settle", boundSeconds: options.wait };
  }
  return { mode: "settle" };
}

/** Flag names as prose: "--a", "--a and --b", "--a, --b and --c". */
function listFlags(flags: readonly string[]): string {
  if (flags.length <= 1) return flags.join("");
  return `${flags.slice(0, -1).join(", ")} and ${flags.at(-1)}`;
}

/**
 * Parse `cf piece call`'s selection flags into the shape the result should
 * arrive in, through the same parser `cf piece get` uses — one grammar, one
 * set of error messages, whichever command a caller reaches for.
 *
 * The one combination refused here is `--filter` with `--show-links`. A link
 * names a position in the result, and a predicate that drops elements leaves
 * the survivors at positions that are no longer the ones they came from, so
 * every address below a filtered array would name the wrong element. It is
 * the same refusal a `$link` marker meets inside the selection step, on the
 * same grounds.
 */
export async function parsePieceCallSelection(
  options: PieceCallReadbackFlags,
): Promise<CellSelection | undefined> {
  const selection = await parseCellSelectionOptions(options);
  if (options.showLinks && selection?.filter !== undefined) {
    throw new ValidationError(
      "--show-links cannot be combined with --filter: a filtered array's " +
        "elements no longer say which positions they came from, and a link " +
        "names a position.",
    );
  }
  return selection;
}

/**
 * The caller's patience bound expired before the invocation settled. The
 * handler runs in THIS process's runtime, so an exit before the commit is
 * acknowledged abandons un-executed work rather than leaving it settling
 * elsewhere: before the `committed` phase, the invocation may not have
 * executed or committed at all. The recovery is re-invoking with the SAME
 * id AND session — safe in every phase, because it deduplicates against the
 * create-only receipt when the commit landed and re-executes when it never
 * did.
 *
 * Both halves are named because both reach the address: an id alone is
 * replayable within no session, and `resolveInvocationIdentity` refuses one
 * offered without its session rather than putting that id on a different
 * outcome. The dispatch announcement puts the pair on stderr, which is where
 * a caller acting on this recovers them from.
 */
export class WaitBoundExpired extends Error {
  constructor(readonly seconds: number) {
    super(
      `--wait bound of ${seconds}s expired: the invocation may not have ` +
        "executed or committed — re-invoke with the same invocation id and " +
        "session to finish it or read the outcome back",
    );
    this.name = "WaitBoundExpired";
  }
}

/**
 * Bound an in-flight settlement wait by the caller's chosen patience.
 *
 * This is a patience bound, not a correctness timeout (the distinction
 * docs/development/waiting-in-tests.md draws): firing early is safe because
 * a caller-supplied invocation id makes a same-id re-invoke safe in EVERY
 * phase. Safe is not lossless — the handler runs locally, so a bound that
 * fires before the commit is acknowledged abandons work that may never have
 * executed or committed — but the re-invoke recovers either way: it
 * deduplicates when the commit landed and re-executes when it never did.
 * That is what permits a wall-clock bound here at all, and only because the
 * caller asked for one; nothing waits by default.
 *
 * Mechanism: one deadline racing the outermost await — the settlement work
 * underneath is event-driven and untouched, and there is no polling anywhere.
 * The timer is cleared once the race resolves, so a call that settles inside
 * the bound leaves no armed timer behind (`AbortSignal.timeout` would keep
 * ticking; a clearable timer is the same one-shot deadline without the
 * leftover).
 */
export function boundedSettlement<T>(
  settlement: Promise<T>,
  boundSeconds: number | undefined,
): Promise<T> {
  if (boundSeconds === undefined) return settlement;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new WaitBoundExpired(boundSeconds)),
      boundSeconds * 1000,
    );
  });
  return Promise.race([settlement, expiry]).finally(() => clearTimeout(timer));
}

export function writePieceRenderStatus(
  message: string,
  jsonOutput: boolean,
): void {
  if (jsonOutput) {
    console.error(message);
  } else {
    console.log(message);
  }
}

export function handlePieceRenderNoUi(
  error: Error,
  jsonOutput: boolean,
): void {
  if (jsonOutput) {
    throw error;
  }
  render("<piece has no UI>");
}

// Override usage, since we do not "require" args that can be reflected by env vars.
const spaceUsage =
  `--identity <identity> --url <url> --api-url <api-url> --space <space>`;
const pieceUsage = `${spaceUsage} --piece <piece>`;

// Render out args for the examples for both `--url`,
// and for the individual components (`--api-url`, `--piece`, `--space`)
const RAW_EX_URL = "https://cf.dev/personal-notes/baed..43mi";
const RAW_EX_COMP = parseUrl(RAW_EX_URL);
const EX_ID = `--identity ./my.key`;
const EX_URL = `--url ${RAW_EX_URL}`;
const EX_COMP = `--api-url ${RAW_EX_COMP.apiUrl} --space ${RAW_EX_COMP.space}`;
const EX_COMP_PIECE = `${EX_COMP} --piece ${RAW_EX_COMP.piece!}`;
const PIECE_REGISTRY_LINK_EXAMPLE = [
  cliText(
    `cf piece link ${EX_ID} ${EX_COMP} fid1:abc123 fid1:piece1/pieceRegistry`,
  ),
  `Link the well-known "pieceRegistry" list to a piece field.`,
] as const;

// Enhanced description with workflow tips
function pieceEnvStatus(): string {
  const identity = Deno.env.get("CF_IDENTITY");
  const apiUrl = Deno.env.get("CF_API_URL");
  if (!identity && !apiUrl) return "";
  const lines: string[] = ["", "ENVIRONMENT:"];
  if (identity) {
    lines.push(
      `  CF_IDENTITY = ${identity} (set, no need to pass --identity)`,
    );
  }
  if (apiUrl) {
    lines.push(
      `  CF_API_URL  = ${apiUrl} (set, no need to pass --api-url)`,
    );
  }
  return lines.join("\n");
}

const pieceDescription = cliText(`Interact with pieces running on a server.

COMMON WORKFLOWS:
  Deploy:    cf piece new ./pattern.tsx -i ./claude.key -a http://localhost:${ports.toolshed} -s my-space
  Update:    cf piece setsrc --piece <ID> ./pattern.tsx -i ./claude.key -a http://localhost:${ports.toolshed} -s my-space
  Test:      cf piece call --piece <ID> callableName -i ./claude.key -a http://localhost:${ports.toolshed} -s my-space
  Inspect:   cf piece inspect --piece <ID> -i ./claude.key -a http://localhost:${ports.toolshed} -s my-space
${pieceEnvStatus()}
TIPS:
  • Use 'setsrc' for iteration, not repeated 'new' (avoids clutter)
  • After 'set', run 'step' to trigger computed value updates
  • Path format: forward slashes only (items/0/name, not items[0].name)
  • JSON values: strings need quotes: echo '"hello"' | cf piece set ...`);

export const piece = new Command()
  .name("piece")
  .description(pieceDescription)
  .error((error, command) => {
    const args = command.getMainCommand().getRawArgs();
    if (reservesStdoutForCommandOutput(args)) {
      throw error;
    }
  })
  .default("help")
  .globalOption("-q,--quiet", "Suppress hints and next-step suggestions")
  .globalOption(
    "-u,--url <url:string>",
    "URL representing a host, space, and piece.",
  )
  .globalEnv("CF_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CF_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CF_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CF_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  .globalOption("-s,--space <space:string>", "The space name or DID")
  /* piece ls */
  .command("ls", "List pieces registered in the space.")
  .usage(spaceUsage)
  .example(
    cliText(`cf piece ls ${EX_ID} ${EX_COMP}`),
    `Display the registered pieces in "${RAW_EX_COMP.space}".`,
  )
  .example(
    cliText(`cf piece ls ${EX_ID} ${EX_URL}`),
    `Display the registered pieces in "${RAW_EX_COMP.space}".`,
  )
  .option("--json", "Output machine-readable JSON.")
  .action(listPiecesFromCommand)
  /* piece search */
  .command("search", "Search input and result data in registered pieces.")
  .usage(`${spaceUsage} <query>`)
  .example(
    cliText(`cf piece search ${EX_ID} ${EX_COMP} "meeting notes"`),
    `Find pieces containing "meeting notes" in nested input or result data.`,
  )
  .example(
    cliText(`cf piece search ${EX_ID} ${EX_URL} invoice --json`),
    `Return matching pieces as machine-readable JSON.`,
  )
  .arguments("<query:string>")
  .option("--json", "Output machine-readable JSON.")
  .action(searchPiecesFromCommand)
  /* piece new */
  .command("new", "Create a new piece with a pattern.")
  .usage(`${spaceUsage} <main>`)
  .example(
    cliText(`cf piece new ${EX_ID} ${EX_COMP} ./main.tsx`),
    `Create a new piece, using ./main.tsx as source.`,
  )
  .example(
    cliText(`cf piece new ${EX_ID} ${EX_URL} ./main.tsx`),
    `Create a new piece, using ./main.tsx as source.`,
  )
  .example(
    cliText(
      `cf piece new ${EX_ID} ${EX_COMP} --root ./patterns ./patterns/wip/main.tsx`,
    ),
    `Create a piece that can import from parent directories within ./patterns.`,
  )
  .arguments("<main:string>")
  .option("--no-start", "Only set up the piece without starting it")
  .option(
    "--main-export <export:string>",
    'Named export from entry for pattern definition. Defaults to "default".',
  )
  .option(
    "--root <path:string>",
    "Root directory for imports and authored source paths. Use a repository root to preserve repository-relative paths.",
  )
  .option(
    "--repository <repository:string>",
    "Repository locator associated with the authored source (stored exactly as supplied).",
  )
  .option(
    "--test <path:string>",
    "Attach a test pattern source file to the deployed source package. Repeatable.",
    { collect: true },
  )
  .option("--slug <slug:string>", "Slug URL/address for this piece.")
  .option(
    "--dangerously-allow-incompatible-schema",
    "Accepted for deploy-script symmetry; a new piece has no previous schema to compare.",
  )
  .action(async (options, main) => {
    setQuietMode(!!options.quiet);
    const spaceConfig = parseSpaceOptions(options);
    const pieceId = await newPiece(
      spaceConfig,
      localPatternEntry(main, options),
      {
        start: options.start,
        slug: options.slug,
      },
    );
    render(pieceId);
    const browserPieceRef = options.slug ?? pieceId;
    hint(cliText(`NEXT STEPS:
  → Open in browser: ${spaceConfig.apiUrl}/${spaceConfig.space}/${browserPieceRef}
  → Update code:     cf piece setsrc --piece ${pieceId} ${main} ...
  → Test a callable: cf piece call --piece ${pieceId} <callableName> ...
  → Inspect state:   cf piece inspect --piece ${pieceId} ...`));
  })
  /* piece set-slug */
  .command(
    "set-slug",
    "Set a slug redirect to a piece or cell link.",
  )
  .usage(`${spaceUsage} <slug> <source>`)
  .example(
    cliText(`cf piece set-slug ${EX_ID} ${EX_COMP} project-notes fid1:piece1`),
    `Set slug "project-notes" to piece "fid1:piece1".`,
  )
  .example(
    cliText(
      `cf piece set-slug ${EX_ID} ${EX_COMP} latest-note old-slug --resolve-before-linking`,
    ),
    `Set slug "latest-note" to the cell currently resolved by "old-slug".`,
  )
  .arguments("<slug:string> <source:string>")
  .option(
    "--resolve-before-linking",
    "Resolve the source cell before writing it as the slug redirect target.",
  )
  .action(async (options, slug, sourceRef) => {
    setQuietMode(!!options.quiet);
    const spaceConfig = parseSpaceOptions(options);
    const source = parseLink(sourceRef);
    await setPieceSlug(
      spaceConfig,
      slug,
      source.pieceId,
      source.path || [],
      {
        sourceScope: source.scope,
        resolveBeforeLinking: !!(options as any).resolveBeforeLinking,
      },
    );
    render(`Set slug ${slug} to ${sourceRef}`);
    hint(cliText(`NEXT STEPS:
  → Open in browser: ${spaceConfig.apiUrl}/${spaceConfig.space}/${slug}`));
  })
  /* piece step */
  .command("step", "Run a single scheduling step: start → idle → synced → stop")
  .usage(pieceUsage)
  .example(
    cliText(`cf piece step ${EX_ID} ${EX_COMP_PIECE}`),
    `Start, wait for idle+synced, then stop piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);
    await stepPiece(pieceConfig);
    render(`Stepped piece ${pieceConfig.piece}`);
  })
  /* piece apply */
  .command("apply", "Pass in new inputs to the target piece")
  .usage(pieceUsage)
  .example(
    cliText(`echo '{"foo":5}' | cf piece apply ${EX_ID} ${EX_COMP_PIECE}`),
    `Applies the input '{"foo":5}' to piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(`echo '{"foo":5}' | cf piece apply ${EX_ID} ${EX_URL}`),
    `Applies the input '{"foo":5}' to piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .action(async (options) =>
    applyPieceInput(parsePieceOptions(options), await drainStdin())
  )
  /* piece getsrc */
  .command("getsrc", "Retrieve the pattern source for the given piece.")
  .usage(`${pieceUsage} <outpath>`)
  .example(
    cliText(`cf piece getsrc ${EX_ID} ${EX_COMP_PIECE} ./out`),
    `Retrieve the source for "${RAW_EX_COMP.piece!}" and place in ./out`,
  )
  .example(
    cliText(`cf piece getsrc ${EX_ID} ${EX_URL} ./out`),
    `Retrieve the source for "${RAW_EX_COMP.piece!}" and place in ./out`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .arguments("<outpath:string>")
  .action((options, outPath) =>
    savePiecePattern(parsePieceOptions(options), absPath(outPath))
  )
  /* piece setsrc */
  .command("setsrc", "Update the pattern source for the given piece.")
  .usage(`${pieceUsage} <main>`)
  .example(
    cliText(`cf piece setsrc ${EX_ID} ${EX_COMP_PIECE} ./main.tsx`),
    `Update the source for "${RAW_EX_COMP.piece!}" with ./main.tsx`,
  )
  .example(
    cliText(`cf piece setsrc ${EX_ID} ${EX_URL} ./main.tsx`),
    `Update the source for "${RAW_EX_COMP.piece!}" with ./main.tsx`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option(
    "--main-export <export:string>",
    'Named export from entry for pattern definition. Defaults to "default".',
  )
  .option(
    "--root <path:string>",
    "Root directory for imports and authored source paths. Use a repository root to preserve repository-relative paths.",
  )
  .option(
    "--repository <repository:string>",
    "Repository locator associated with the authored source (stored exactly as supplied).",
  )
  .option(
    "--test <path:string>",
    "Attach a test pattern source file to the deployed source package. Repeatable.",
    { collect: true },
  )
  .option(
    "--dangerously-allow-incompatible-schema",
    "Replace the source even when pattern or retained-link schema compatibility cannot be proven.",
  )
  .option(
    "--check",
    "Report whether the source could replace the piece's current one, without updating the piece. Exits non-zero when it could not.",
  )
  .arguments("<main:string>")
  .action(async (options, mainPath) => {
    setQuietMode(!!options.quiet);
    if (options.check) {
      // A refusal exits 1 from inside the check (plain stderr, no usage
      // dump), so `--check` gates a deploy script as well as informing a
      // person.
      const { config, summary } = await checkPieceSourceFromCommand(
        options,
        mainPath,
      );
      render(summary);
      hint(cliText(`NEXT STEPS:
  → Apply it: cf piece setsrc --piece ${config.piece} ${mainPath} ...`));
      return;
    }
    const pieceConfig = await setPieceSourceFromCommand(options, mainPath);
    render(`Updated source for piece ${pieceConfig.piece}`);
    hint(cliText(`NEXT STEPS:
  → Test in browser: ${pieceConfig.apiUrl}/${pieceConfig.space}/${pieceConfig.piece}
  → Test a callable: cf piece call --piece ${pieceConfig.piece} <callableName> ...
  → Check state:     cf piece inspect --piece ${pieceConfig.piece} ...`));
  })
  /* piece inspect */
  .command("inspect", "Inspect detailed information about a piece")
  .usage(pieceUsage)
  .example(
    cliText(`cf piece inspect ${EX_ID} ${EX_COMP_PIECE}`),
    `Inspect detailed information about piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(`cf piece inspect ${EX_ID} ${EX_URL}`),
    `Inspect detailed information about piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--json", "Output raw JSON data")
  .option(
    "--summary",
    "Show a compact summary: scalars only, arrays/objects replaced with type descriptors, $-prefixed internal keys omitted",
  )
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);

    const pieceData = await inspectPiece(pieceConfig);

    const displayData = options.summary
      ? {
        ...pieceData,
        source: summarizeForDisplay(pieceData.source),
        result: summarizeForDisplay(pieceData.result),
      }
      : pieceData;

    if (options.json) {
      // In JSON mode, use render with JSON output
      render(displayData, { json: true });
      return;
    }

    // Build formatted output as template
    let output = `
=== Piece: ${pieceData.id} ===
Name: ${pieceData.name || "<no name>"}
Pattern: ${formatPatternRef(pieceData.patternRef)}
Pattern Ref: ${formatPatternIdentity(pieceData.patternRef)}
Source Ref: ${pieceData.patternRef?.source.ref ?? "<unknown>"}
Repository: ${pieceData.patternRef?.source.repository ?? "<unknown>"}
Source Entry: ${pieceData.patternRef?.source.entry ?? "<unknown>"}
Source Origin: ${pieceData.patternRef?.source.origin ?? "<unknown>"}

--- Source (Inputs) ---`;

    if (displayData.source) {
      output += `\n${safeStringify(displayData.source)}`;
    } else {
      output += "\n<no source data>";
    }

    output += "\n\n--- Result ---";
    if (displayData.result !== null && displayData.result !== undefined) {
      const isPlainObject = typeof displayData.result === "object" &&
        !Array.isArray(displayData.result);
      if (!options.summary && isPlainObject) {
        // Filter out large UI objects that clutter the non-summary output
        const filteredResult = {
          ...(displayData.result as Record<string | symbol, unknown>),
        };
        if (UI in filteredResult && typeof filteredResult[UI] === "object") {
          filteredResult[UI] = "<large UI object - use --json to see full UI>";
        }
        output += `\n${safeStringify(filteredResult)}`;
      } else {
        output += `\n${safeStringify(displayData.result)}`;
      }
    } else {
      output += "\n<no result data>";
    }

    output += "\n\n--- Reading From ---";
    if (pieceData.readingFrom.length > 0) {
      pieceData.readingFrom.forEach((ref) => {
        output += `\n  - ${ref.id}${ref.name ? ` (${ref.name})` : ""}`;
      });
    } else {
      output += "\n  (none)";
    }

    output += "\n\n--- Read By ---";
    if (pieceData.readBy.length > 0) {
      pieceData.readBy.forEach((ref) => {
        output += `\n  - ${ref.id}${ref.name ? ` (${ref.name})` : ""}`;
      });
    } else {
      output += "\n  (none)";
    }

    render(output);
  })
  /* piece view */
  .command("view", "Display the rendered view for a piece")
  .usage(pieceUsage)
  .example(
    cliText(`cf piece view ${EX_ID} ${EX_COMP_PIECE}`),
    `Display the view for piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(`cf piece view ${EX_ID} ${EX_URL}`),
    `Display the view for piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--json", "Output raw JSON data")
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);
    const view = await getPieceView(pieceConfig);
    if (options.json) {
      render(view ?? null, { json: true });
      return;
    }
    if (view) {
      const tree = formatViewTree(view);
      render(tree);
    } else {
      render("<no view data>");
    }
  })
  /* piece render */
  .command("render", "Render a piece's UI to HTML")
  .usage(pieceUsage)
  .example(
    cliText(`cf piece render ${EX_ID} ${EX_COMP_PIECE}`),
    `Render the UI for piece "${RAW_EX_COMP.piece!}" to HTML.`,
  )
  .example(
    cliText(`cf piece render ${EX_ID} ${EX_URL}`),
    `Render the UI for piece "${RAW_EX_COMP.piece!}" to HTML.`,
  )
  .example(
    cliText(`cf piece render ${EX_ID} ${EX_COMP_PIECE} --watch`),
    `Watch and re-render piece "${RAW_EX_COMP.piece!}" when UI changes.`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--json", "Output HTML as JSON")
  .option("-w,--watch", "Watch for changes and re-render")
  .option(
    "--no-start",
    "Render without starting the piece (useful when another instance is running it)",
  )
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);

    try {
      if (options.watch) {
        writePieceRenderStatus(
          "Watching for changes... Press Ctrl+C to exit.\n",
          !!options.json,
        );

        // Initial render
        const pieceData = await inspectPiece(pieceConfig);
        writePieceRenderStatus(
          `Rendering piece: ${pieceData.name || pieceConfig.piece}`,
          !!options.json,
        );

        let renderCount = 0;
        const cleanup = await renderPiece(pieceConfig, {
          watch: true,
          start: options.start,
          onUpdate: (html) => {
            renderCount++;
            writePieceRenderStatus(
              `\n--- Render #${renderCount} ---`,
              !!options.json,
            );
            if (options.json) {
              render({ html, renderCount }, { json: true });
            } else {
              render(html);
            }
          },
        }) as () => void;

        // Handle Ctrl+C gracefully
        Deno.addSignalListener("SIGINT", () => {
          writePieceRenderStatus("\nStopping watch mode...", !!options.json);
          cleanup();
          Deno.exit(0);
        });

        // Keep the process running
        await new Promise(() => {});
      } else {
        const html = await renderPiece(pieceConfig, {
          start: options.start,
        }) as string;
        if (options.json) {
          render({ html }, { json: true });
        } else {
          render(html);
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("has no UI")) {
        handlePieceRenderNoUi(error, !!options.json);
      } else {
        throw error;
      }
    }
  })
  /* piece link */
  .command(
    "link",
    `Link a field from one piece to another for reactive data flow.

WELL-KNOWN IDS: System-level data (like pieceRegistry) can be linked using
well-known IDs. See docs/common/concepts/well-known-ids.md for IDs and usage.`,
  )
  .usage(`${spaceUsage} <source> <target>`)
  .example(
    cliText(
      `cf piece link ${EX_ID} ${EX_COMP} fid1:piece1/outputEmails fid1:piece2/emails`,
    ),
    `Link outputEmails field from piece "fid1:piece1" to emails field in piece "fid1:piece2".`,
  )
  .example(
    cliText(
      `cf piece link ${EX_ID} ${EX_COMP} fid1:piece1/data/users/0/email fid1:piece2/config/primaryEmail`,
    ),
    `Link deep nested field including array access.`,
  )
  .example(
    cliText(
      `cf piece link ${EX_ID} ${EX_COMP} fid1:piece1@user/profile fid1:piece2@session/currentProfile`,
    ),
    `Link scoped cell instances using @user or @session on the piece ID.`,
  )
  .example(...PIECE_REGISTRY_LINK_EXAMPLE)
  .example(
    cliText(
      `cf piece link ${EX_ID} ${EX_COMP} sqlite:/data/reference.db fid1:piece1/refDb`,
    ),
    `Inject a read-only on-disk SQLite file as a piece's SqliteDb input (Phase 7).`,
  )
  .arguments("<source:string> <target:string>")
  .option("--no-start", "Only link without starting the pieces")
  .option(
    "--allow-non-existing",
    "Allow linking to/from pieces or paths that don't exist yet",
  )
  .action(async (options, sourceRef, targetRef) => {
    setQuietMode(!!options.quiet);
    const spaceConfig = parseSpaceOptions(options);

    // Phase 7: `cf piece link sqlite:<absPath> <piece>/<field>` injects a
    // read-only on-disk SQLite source into the target field (v1). Detect this
    // BEFORE parseLink (the sqlite: scheme is not a piece ref).
    const sqliteSource = parseSqliteSource(sourceRef);
    if (sqliteSource) {
      const target = parseLink(targetRef);
      if (!target.path) {
        throw new ValidationError(
          `Target reference must include a path. Expected: pieceId/path/to/field`,
          { exitCode: 1 },
        );
      }
      await linkSqliteDiskSource(
        spaceConfig,
        sqliteSource.path,
        target.pieceId,
        target.path,
        { start: options.start, targetScope: target.scope },
      );
      render(`Linked ${sourceRef} to ${targetRef} (read-only on-disk source)`);
      hint(cliText(`NEXT STEPS:
  → Inspect target piece:  cf piece inspect --piece ${target.pieceId} ...`));
      return;
    }

    // Parse source and target references - handle both pieceId/path and well-known IDs
    const source = parseLink(sourceRef, { allowWellKnown: true });
    const target = parseLink(targetRef);

    // For linking, sources can be either:
    // 1. pieceId (links entire result cell)
    // 2. pieceId/path/to/field (links specific field in result cell)
    // Both well-known IDs and regular piece IDs can link without a path

    if (!target.path) {
      throw new ValidationError(
        `Target reference must include a path. Expected: pieceId/path/to/field`,
        { exitCode: 1 },
      );
    }

    try {
      await linkPieces(
        spaceConfig,
        source.pieceId,
        source.path || [], // Empty path for well-known IDs
        target.pieceId,
        target.path,
        {
          start: options.start,
          allowNonExisting: !!(options as any).allowNonExisting,
          sourceScope: source.scope,
          targetScope: target.scope,
        },
      );
    } catch (error) {
      // A link that fails validation is a data error (the pieces/paths read
      // over the network don't support the link), not a usage error — report
      // it like `piece get` does instead of letting Cliffy dump the help
      // screen over it.
      const report = pieceLinkDataErrorReport(error, {
        sourcePieceId: source.pieceId,
        targetPieceId: target.pieceId,
      });
      if (report) exitWithDataError(report);
      throw error;
    }

    render(`Linked ${sourceRef} to ${targetRef}`);
    hint(cliText(`NEXT STEPS:
  → Visualize connections: cf piece map -i ... -a ... -s ...
  → Inspect target piece:  cf piece inspect --piece ${target.pieceId} ...`));
  })
  /* piece get */
  .command(
    "get",
    `Get a value from a piece at a specific path. Omit path to return the full result.

PATH FORMAT: Use forward slashes and numeric indices for arrays.
  ✓ items/0/name    ✓ config/db/host    ✗ items[0].name`,
  )
  .usage(`${pieceUsage} [path]`)
  .example(
    cliText(`cf piece get ${EX_ID} ${EX_COMP_PIECE} name`),
    `Get the "name" field from piece result "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(
      `cf piece get ${EX_ID} ${EX_COMP_PIECE} data/users/0/email --input`,
    ),
    `Get a nested field value from piece input "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(
      `cf piece get ${EX_ID} ${EX_COMP} --piece ${RAW_EX_COMP
        .piece!}@session draft`,
    ),
    `Get a value from a session-scoped piece instance.`,
  )
  .example(
    cliText(`cf piece get ${EX_ID} ${EX_COMP_PIECE}`),
    `Get the full result of piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(`cf piece get ${EX_ID} ${EX_COMP_PIECE} --step`),
    `Start, recompute, and get the result in one CLI session.`,
  )
  .example(
    cliText(
      `cf piece get ${EX_ID} ${EX_COMP_PIECE} items --filter '.status == "open"'`,
    ),
    "Return only matching items from an array.",
  )
  .example(
    cliText(
      `cf piece get ${EX_ID} ${EX_COMP_PIECE} items --select id,title`,
    ),
    "Project each returned item to selected fields.",
  )
  .example(
    cliText(
      `cf piece get ${EX_ID} ${EX_COMP_PIECE} --select 'topic@,topic.title'`,
    ),
    "Return a field's address, and the fields asked for beside it.",
  )
  .example(
    cliText(
      `cf piece get ${EX_ID} ${EX_COMP_PIECE} items ` +
        `--schema '{"type":"array","items":{"$link":true}}'`,
    ),
    "Return each item's address instead of its contents.",
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--input", "Read from the piece's input cell instead of result cell")
  .option(
    "--step",
    "Start and recompute the piece in this session before reading",
  )
  .option(
    "--json",
    "Select JSON output explicitly. This command always outputs JSON.",
  )
  .option(
    "--filter <predicate:string>",
    "Filter an array with a jq-inspired predicate",
  )
  .option(
    "--select <fields:string>",
    "Project output to comma-separated field paths; a trailing @ asks for a " +
      "position's address, and @ alone for the source's own",
  )
  .option(
    "--schema <schema:string>",
    "Project output with an inline JSON Schema, @file, or the --select " +
      "field list",
    // Both flags carry the one projection, so a command naming both has not
    // said which shape it wants. Refuse before the read rather than pick.
    { conflicts: ["select"] },
  )
  .arguments("[path:string]")
  .action(async (options, pathString) => {
    setQuietMode(!!options.quiet);
    const pieceConfig = {
      ...parsePieceOptions(options),
      jsonOutput: true,
    };
    const pathSegments = pathString ? parseCellPath(pathString) : [];
    try {
      const selection = await parseCellSelectionOptions(options);
      const value = await getCellValue(pieceConfig, pathSegments, {
        input: options.input,
        step: options.step,
        ...(selection === undefined ? {} : { selection }),
      });
      render(value, { json: true });
    } catch (error) {
      // A read that fails on a data condition — the path doesn't resolve, or
      // the result schema can't project the stored data (PieceResultProjection
      // Error) — is a data error, not a usage error. Report it on stderr
      // instead of letting Cliffy dump the help screen over it.
      const report = pieceGetDataErrorReport(error, {
        input: options.input,
        piece: pieceConfig.piece,
      });
      if (report) exitWithDataError(report);
      throw error;
    }
  })
  /* piece set */
  .command(
    "set",
    cliText(`Set a value in a piece at a specific path. Reads JSON from stdin.

PATH FORMAT: Use forward slashes and numeric indices for arrays.
  ✓ items/0/name    ✓ config/db/host    ✗ items[0].name

JSON VALUES: Strings need quotes: echo '"hello"' | cf piece set ...`),
  )
  .usage(`${pieceUsage} <path>`)
  .example(
    cliText(`echo '"New Name"' | cf piece set ${EX_ID} ${EX_COMP_PIECE} name`),
    `Set the "name" field in piece result "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(
      `echo '{"foo": "bar"}' | cf piece set ${EX_ID} ${EX_COMP_PIECE} config --input`,
    ),
    `Set a nested object value in piece input "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--input", "Write to the piece's input cell instead of result cell")
  .arguments("<path:string>")
  .action(async (options, pathString) => {
    setQuietMode(!!options.quiet);
    const pieceConfig = parsePieceOptions(options);
    const pathSegments = parseCellPath(pathString);
    const value = await drainStdin();
    await setCellValue(pieceConfig, pathSegments, value, {
      input: options.input,
    });
    render(`Set value at path: ${pathString}`);
    hint(
      cliText(
        `TIP: Computed values may be stale. Run 'cf piece step --piece ${pieceConfig.piece} ...' to trigger recomputation.`,
      ),
    );
  })
  /* piece map */
  .command("map", "Show registered pieces and the connections between them")
  .usage(spaceUsage)
  .example(
    cliText(`cf piece map ${EX_ID} ${EX_COMP}`),
    `Display registered pieces and connections in "${RAW_EX_COMP.space}".`,
  )
  .example(
    cliText(`cf piece map ${EX_ID} ${EX_COMP} --format dot`),
    `Output Graphviz DOT format for the space.`,
  )
  .option(
    "-f,--format <format:string>",
    "Output format: ascii (default) or dot (Graphviz)",
    { default: "ascii" },
  )
  .action(async (options) => {
    const spaceConfig = parseSpaceOptions(options);
    const format = options.format === "dot" ? MapFormat.DOT : MapFormat.ASCII;

    const map = await generateSpaceMap(spaceConfig, format);
    render(map);
  })
  /* piece call */
  .command(
    "call",
    `Invoke a callable within a piece.

The callable name separates piece-call options from the callable's arguments.
Arguments after the callable use the same parser as cf exec. Use --json with an
optional inline value for complete JSON input; bare --json reads JSON from
stdin. A single positional JSON value or "-" stdin sentinel is also accepted.
Use --help --json for machine-readable schema help. Put schema-derived flags
after --. Handlers interpret piped input when no input argument is present.`,
  )
  .usage(`${pieceUsage} <callable> [input]`)
  .example(
    cliText(`cf piece call ${EX_ID} ${EX_COMP_PIECE} increment`),
    `Call the "increment" handler on piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(
      `cf piece call ${EX_ID} ${EX_COMP_PIECE} setName '{"value":"My Name"}'`,
    ),
    `Call the "setName" handler with JSON arguments on piece "${RAW_EX_COMP
      .piece!}".`,
  )
  .example(
    cliText(
      `echo '{"value":"My Name"}' | cf piece call ${EX_ID} ${EX_COMP_PIECE} setName -`,
    ),
    `Read the JSON payload from stdin ("-" is the stdin sentinel).`,
  )
  .example(
    cliText(
      `cf piece call ${EX_ID} ${EX_COMP_PIECE} setName --json '{"value":"My Name"}'`,
    ),
    "Call a handler with explicit inline JSON input.",
  )
  .example(
    cliText(`cf piece call ${EX_ID} ${EX_COMP_PIECE} search -- --query milk`),
    `Run the "search" tool using schema-derived flags after "--".`,
  )
  .example(
    cliText(
      `cf piece call ${EX_ID} ${EX_COMP_PIECE} --select topic.title addTopic ` +
        `'{"title":"Ship it"}'`,
    ),
    "Return only the selected fields of the verb's result.",
  )
  .example(
    cliText(
      `cf piece call ${EX_ID} ${EX_COMP_PIECE} ` +
        `--schema '{"properties":{"topic":{"$link":true}}}' addTopic ` +
        `'{"title":"Ship it"}'`,
    ),
    "Return the address of what the verb returned instead of its contents.",
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option(
    "--invocation <id:string>",
    "Idempotency key for a handler call (before the callable name), and " +
      "requires an invocation session. A retry naming the same pair cannot " +
      "commit twice — it settles on the original outcome — but the " +
      "handler body does re-run, so effects outside the transaction " +
      "repeat. Both are minted for the one call when neither is given.",
  )
  .env(
    "CF_INVOCATION_SESSION=<id:string>",
    "Invocation session that this run's invocation ids belong to. The form " +
      "to reach for: a session is what makes an outcome's address " +
      "unguessable, and an environment variable stays out of the process " +
      "listing an argument shows up in.",
    { prefix: "CF_" },
  )
  .option(
    "--invocation-session <id:string>",
    "Override CF_INVOCATION_SESSION for this one call (before the callable " +
      "name): the session this call's invocation id was chosen within, " +
      "since an invocation id is the caller's own word and another caller " +
      "can pick the same one. The pair decides which outcome a replay " +
      "reads, so the same id under another session is another invocation. " +
      "Mint a session per agent run with `cf invocation-session new`, and " +
      "carry that one session on every call of the run.",
  )
  .option(
    "--verbose",
    "Print per-phase wall-clock timings to stderr (before the callable " +
      "name). stdout still carries only the command output.",
  )
  .option(
    "--await",
    "Wait for settlement and receipt readback (before the callable name). " +
      "This is the default; the flag exists so a script can say so " +
      "explicitly. Contradicts --no-wait.",
  )
  .option(
    "--wait <seconds:number>",
    "Bound the settlement wait by a chosen patience, in seconds (before " +
      "the callable name). On expiry the exit is nonzero with the " +
      "invocation id and furthest phase on stderr; the invocation may not " +
      "have executed or committed, and re-invoking under the same id and " +
      "session is safe in every phase — it finishes the work or reads the " +
      "outcome back.",
  )
  .option(
    "--no-wait",
    "Exit once this handling's commit is acknowledged (before the callable " +
      "name), skipping only the receipt readback: stdout reports status " +
      '"committed" plus the receipt address, so `cf piece get --piece <that ' +
      "id>` collects the outcome later without re-running the handler; a " +
      "call naming the same session and --invocation recovers it too, but " +
      "runs the handler body again. The handler still executes here and its " +
      "commit is durable. Handler invocations only.",
  )
  .option(
    "--show-links",
    "Annotate the Invocation JSON with a links dictionary mapping result " +
      "paths to their backing cell addresses (before the callable name). " +
      'The root "/" entry is the result\'s own backing document — the ' +
      "receipt, unless the result is itself a reference, in which case a " +
      'separate "receipt" entry keeps the receipt address; other entries ' +
      "appear only where a path is backed by a different document. Handler " +
      "invocations only — a tool already reports its result cell on stderr.",
  )
  .option(
    "--filter <predicate:string>",
    "Filter an array with a jq-inspired predicate",
  )
  .option(
    "--select <fields:string>",
    "Project output to comma-separated field paths",
  )
  .option(
    "--schema <schema:string>",
    "Project output with an inline JSON Schema, @file, or the --select " +
      "field list",
    // Both flags carry the one projection, so a command naming both has not
    // said which shape it wants. Refuse before the call rather than pick.
    { conflicts: ["select"] },
  )
  .stopEarly()
  .arguments("<callable:string> [tail...:string]")
  .action(async function (options, callableName, ...tail) {
    const identity = resolveInvocationIdentity(
      options.invocation,
      options.invocationSession,
    );
    const invocationId = identity.id;
    const waitControl = resolveWaitControl(options);
    let phase: InvocationPhase = "initial_sync";
    const observer = pieceCallPhaseObserver(
      !!options.verbose,
      (next) => phase = next,
    );
    setQuietMode(!!options.quiet);
    // Read outside the invocation's failure wrapper below. Nothing is
    // dispatched here — no callable resolved, no id spent — so a malformed
    // selection is a data error about the flags, the same one `cf piece get`
    // reports. Inside the wrapper it would name an id and a phase to retry
    // from for a call that was never made; a selection that fails against a
    // RESULT does sit inside it, and does name one.
    let selection: CellSelection | undefined;
    try {
      selection = await parsePieceCallSelection(options);
    } catch (error) {
      // Both exits below leave without reaching the action's catch, so the
      // verbose in-flight span is closed here.
      observer.finish("failed");
      if (error instanceof CellSelectionError) {
        exitWithDataError({ message: error.message });
      }
      throw error;
    }
    try {
      const invocation = pieceCallInvocation(
        tail,
        this.getLiteralArgs(),
      );
      const pieceConfig = parsePieceOptions({
        ...options,
        json: invocation.jsonOutput,
      });
      const result = await boundedSettlement(
        executePieceCallable(
          pieceConfig,
          callableName,
          invocation.rawArgs,
          {
            invocation: identity,
            skipReadback: waitControl.mode === "commit",
            showLinks: !!options.showLinks,
            ...(selection === undefined ? {} : { selection }),
            onPhase: invocationPhaseReporter(
              identity,
              observer.onPhase,
              undefined,
              Boolean(Deno.env.get("CF_TEST_ANNOUNCE_INVOCATION_PHASES")),
            ),
          },
        ).catch((error) =>
          reportVerbInputErrorOrRethrow(
            error,
            pieceConfig.piece,
            undefined,
            observer,
          )
        ),
        waitControl.boundSeconds,
      );
      renderPieceCallOutcome(
        observer,
        result,
        callableName,
        pieceConfig.piece,
        {},
        { detached: waitControl.mode === "commit", invocation: identity },
      );
    } catch (error) {
      if (error instanceof ValidationError) {
        observer.finish("failed");
        throw error;
      }
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      observer.finish("failed");
      // Where the invocation stopped decides retry semantics: anything at or
      // past "dispatched" retries SAFELY ONLY with this same id (same-id
      // retries deduplicate; a fresh id would re-execute).
      console.error(`invocation: ${invocationId} phase: ${phase}`);
      if (error instanceof WaitBoundExpired) {
        // The caller's patience expired. The handler runs in this process,
        // so the invocation may not have executed or committed — the
        // recovery is a same-id re-invoke, which the stderr message names.
        // stdout still carries the Invocation JSON with the furthest
        // observed phase — the same machine surface as a settled call, so a
        // script parses one shape either way.
        render(
          JSON.stringify(
            invocationJson({ id: invocationId, status: phase }),
            null,
            2,
          ),
        );
      }
      Deno.exit(1);
    }
  })
  /* piece verbs */
  .command(
    "verbs",
    "List a piece's callable verbs (handlers and tools) with their schemas.",
  )
  .usage(pieceUsage)
  .example(
    cliText(`cf piece verbs ${EX_ID} ${EX_COMP_PIECE}`),
    `List every verb piece "${RAW_EX_COMP.piece!}" exposes.`,
  )
  .example(
    cliText(`cf piece verbs ${EX_ID} ${EX_URL} --json`),
    "Machine-readable listing: name, kind, and input schema per verb.",
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--json", "Output machine-readable JSON.")
  .option(
    "--all",
    "Include wrapper-tier and deprecated verbs the default listing hides. " +
      "Hidden verbs stay callable either way.",
  )
  .action(async (options) => {
    setQuietMode(!!options.quiet);
    const pieceConfig = parsePieceOptions(options);
    const listing = await listPieceCallables(pieceConfig);
    // Default view: wrapper-tier (session-UI affordances) and deprecated
    // verbs are omitted, LOUDLY — the hidden counts always print, so nothing
    // is silently invisible. Rows carry their marks in both views, and
    // `cf piece call` never consults them.
    const partition = partitionVerbListing(listing.verbs);
    const hiddenCount = partition.wrapper + partition.deprecated;
    const shown = options.all ? listing.verbs : partition.shown;
    const omission = hiddenCount > 0 && !options.all
      ? `${partition.wrapper} wrapper, ${partition.deprecated} deprecated hidden; --all lists them`
      : undefined;
    if (options.json) {
      render({
        ...listing,
        verbs: shown,
        ...(omission !== undefined
          ? {
            hidden: {
              wrapper: partition.wrapper,
              deprecated: partition.deprecated,
            },
          }
          : {}),
      }, { json: true });
      return;
    }
    if (shown.length === 0) {
      render(
        omission !== undefined
          ? `<no callable verbs shown> (${omission})`
          : "<no callable verbs>",
      );
      return;
    }
    if (listing.pattern) {
      render(`PATTERN ${formatPatternIdentity(listing.pattern)}`);
    }
    render(
      Table.from([
        ["NAME", "KIND", "ON", "MARKS"],
        ...shown.map((v) => [
          v.name,
          v.kind,
          v.on,
          [
            ...(v.tier === "wrapper" ? ["wrapper"] : []),
            ...(v.deprecated ? ["deprecated"] : []),
          ].join(","),
        ]),
      ]).toString(),
    );
    if (omission !== undefined) render(`(${omission})`);
    hint(
      cliText(
        `TIP: --json includes each verb's input schema; 'cf piece call --piece ${pieceConfig.piece} <verb> --help --json' has the full command spec.`,
      ),
    );
  })
  /* piece rm */
  .command("rm", "Remove a piece")
  .alias("remove")
  .usage(pieceUsage)
  .example(
    cliText(`cf piece rm ${EX_ID} ${EX_COMP_PIECE}`),
    `Remove piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    cliText(`cf piece rm ${EX_ID} ${EX_URL}`),
    `Remove piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);
    await removePiece(pieceConfig);
    render(`Removed piece ${pieceConfig.piece}`);
  })
  /* piece recreate-root */
  .command(
    "recreate-root",
    "Recreate the root pattern for the explicitly targeted space.",
  )
  .usage(spaceUsage)
  .example(
    cliText(`cf piece recreate-root ${EX_ID} ${EX_COMP}`),
    `Recreate the root pattern for "${RAW_EX_COMP.space}".`,
  )
  .example(
    cliText(`cf piece recreate-root ${EX_ID} ${EX_URL}`),
    `Recreate the root pattern for "${RAW_EX_COMP.space}".`,
  )
  .action(async (options) => {
    setQuietMode(!!options.quiet);
    const spaceConfig = parseSpaceOptions(options);
    const pieceId = await recreateSpaceRootPattern(spaceConfig);
    render(pieceId);
    hint(cliText(`NEXT STEPS:
  → Open space in browser: ${spaceConfig.apiUrl}/${spaceConfig.space}/${pieceId}
  → Inspect state:         cf piece inspect --piece ${pieceId} ...`));
  })
  /* piece set-home */
  .command(
    "set-home",
    "Deploy a custom home-space pattern or reset the identity's home space to system default.",
  )
  .example(
    cliText(
      `cf piece set-home ${EX_ID} -a http://localhost:${ports.toolshed} ./my-home.tsx`,
    ),
    `Deploy a custom pattern to the identity's home space.`,
  )
  .example(
    cliText(
      `cf piece set-home ${EX_ID} -a http://localhost:${ports.toolshed} --reset`,
    ),
    `Reset the identity's home space to the system default pattern.`,
  )
  .option("--reset", "Reset to the system default home pattern")
  .option(
    "--main-export <export:string>",
    'Named export from entry for pattern definition. Defaults to "default".',
  )
  .option(
    "--root <path:string>",
    "Root directory for imports and authored source paths. Use a repository root to preserve repository-relative paths.",
  )
  .option(
    "--repository <repository:string>",
    "Repository locator associated with the authored source (stored exactly as supplied).",
  )
  .option(
    "--test <path:string>",
    "Attach a test pattern source file to the deployed source package. Repeatable.",
    { collect: true },
  )
  .arguments("[main:string]")
  .action(async (options, main?: string) => {
    setQuietMode(!!options.quiet);

    if (!options.reset && !main) {
      throw new ValidationError(
        "Provide a pattern file path or use --reset.",
        { exitCode: 1 },
      );
    }
    if (options.reset && main) {
      throw new ValidationError(
        "Cannot use --reset with a pattern file path.",
        { exitCode: 1 },
      );
    }
    if (options.reset && options.repository !== undefined) {
      throw new ValidationError(
        "Cannot use --repository with --reset.",
        { exitCode: 1 },
      );
    }
    if (options.reset && options.test !== undefined) {
      throw new ValidationError(
        "Cannot use --test with --reset.",
        { exitCode: 1 },
      );
    }

    const baseConfig = parseSetHomeOptions(options);

    if (options.reset) {
      await resetHomePattern(baseConfig);
      render("Reset home pattern to system default.");
    } else {
      await setHomePattern(baseConfig, localPatternEntry(main!, options));
      render("Deployed custom home pattern.");
    }

    hint(cliText(`NEXT STEPS:
  → Open home in browser: ${baseConfig.apiUrl}
  → Reset to default:     cf piece set-home --reset ...`));
  });

/** Shared flags accepted by piece commands that resolve a target or source. */
export interface PieceCLIOptions {
  piece?: string;
  apiUrl?: string;
  identity?: string;
  space?: string;
  url?: string;
  mainExport?: string;
  repository?: string;
  root?: string;
  test?: string[];
  dangerouslyAllowIncompatibleSchema?: boolean;
  json?: boolean;
}

export interface PieceSummaryCLIOptions extends PieceCLIOptions {
  json?: boolean;
}

export interface PieceListCommandDependencies {
  listPieces?: typeof listPieces;
  renderPieceSummaries?: typeof renderPieceSummaries;
}

export async function listPiecesFromCommand(
  options: PieceSummaryCLIOptions,
  deps: PieceListCommandDependencies = {},
): Promise<void> {
  const pieces = await (deps.listPieces ?? listPieces)(
    parseSpaceOptions(options),
  );
  (deps.renderPieceSummaries ?? renderPieceSummaries)(pieces, !!options.json);
}

export interface PieceSearchCommandDependencies {
  searchPieces?: typeof searchPieces;
  renderPieceSummaries?: typeof renderPieceSummaries;
}

export async function searchPiecesFromCommand(
  options: PieceSummaryCLIOptions,
  query: string,
  deps: PieceSearchCommandDependencies = {},
): Promise<void> {
  const pieces = await (deps.searchPieces ?? searchPieces)(
    parseSpaceOptions(options),
    query,
  );
  (deps.renderPieceSummaries ?? renderPieceSummaries)(pieces, !!options.json);
}

/** Injectable dependencies for testing the `piece setsrc` command boundary. */
export interface SetPieceSourceCommandDependencies {
  setPiecePattern?: typeof setPiecePattern;
}

/** Injectable dependencies for testing `piece setsrc --check`. */
export interface CheckPieceSourceCommandDependencies {
  checkPiecePattern?: typeof checkPiecePattern;
  /** `exitWithDataError`'s seam, so a test can observe the refusal. */
  exit?: Parameters<typeof exitWithDataError>[1];
}

/**
 * Run the `piece setsrc --check` preflight. Applies nothing.
 *
 * Deliberately parses the same options `setsrc` does, so the check is aimed at
 * the piece and entry the apply would have used — a preflight against a
 * different target is worse than none.
 *
 * The refusal is raised here rather than in the command's action so that the
 * decision — including the non-zero exit that lets `--check` gate a deploy
 * script — is reachable by a test. The action only renders what it returns.
 */
export async function checkPieceSourceFromCommand(
  options: PieceCLIOptions,
  mainPath: string,
  deps: CheckPieceSourceCommandDependencies = {},
): Promise<{
  config: PieceConfig;
  report: PatternCompatibilityReport;
  summary: string;
}> {
  const config = parsePieceOptions(options);
  const report = await (deps.checkPiecePattern ?? checkPiecePattern)(
    config,
    localPatternEntry(mainPath, options),
  );
  if (!report.compatible) {
    // A refusal is a data condition — this source and this piece's stored
    // state don't fit — not an arg-parse failure, so it reports like the
    // `piece get` / `piece link` data errors above: plain stderr and exit 1,
    // never a Cliffy ValidationError, which would dump the usage screen over
    // the verdict.
    exitWithDataError({
      message:
        `${mainPath} cannot replace the source for piece ${config.piece}:\n${report.message}`,
    }, deps.exit);
  }
  return {
    config,
    report,
    summary: `${mainPath} can replace the source for piece ${config.piece}`,
  };
}

/** Apply the parsed `piece setsrc` command while preserving its safety flag. */
export async function setPieceSourceFromCommand(
  options: PieceCLIOptions,
  mainPath: string,
  deps: SetPieceSourceCommandDependencies = {},
): Promise<PieceConfig> {
  const pieceConfig = parsePieceOptions(options);
  await (deps.setPiecePattern ?? setPiecePattern)(
    pieceConfig,
    localPatternEntry(mainPath, options),
    {
      dangerouslyAllowIncompatibleSchema:
        options.dangerouslyAllowIncompatibleSchema,
    },
  );
  return pieceConfig;
}

const CELL_SCOPE_VALUES = new Set(["space", "user", "session"]);

function parseScopedIdSegment(id: string): {
  id: string;
  scope?: CellScope;
} {
  const scopeSeparator = id.lastIndexOf("@");
  if (scopeSeparator === -1) return { id };

  const scope = id.slice(scopeSeparator + 1);
  const scopedId = id.slice(0, scopeSeparator);
  if (!scopedId || !CELL_SCOPE_VALUES.has(scope)) {
    throw new ValidationError(
      `Invalid scope suffix "@${scope}". Expected @space, @user, or @session.`,
      { exitCode: 1 },
    );
  }

  return { id: scopedId, scope: scope as CellScope };
}

function parseSetHomeOptions(
  input: PieceCLIOptions,
): Omit<SpaceConfig, "space"> {
  if (!input.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  const apiUrl = input.apiUrl;
  if (!apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }
  return { identity: absPath(input.identity), apiUrl };
}

export function parsePieceOptions(input: PieceCLIOptions): PieceConfig {
  const options = parseSpaceOptions(input);
  if (!("piece" in options) || !options.piece) {
    throw new ValidationError(
      `Missing required option: "--piece".`,
      { exitCode: 1 },
    );
  }
  return options as PieceConfig;
}

// With args and env vars shadowing each other, and multiple
// ways of defining service components, we cannot make the options
// "required" with cliffy. Ensure that all required values are
// available after parsing both args and env vars.
export function parseSpaceOptions(
  input: PieceCLIOptions,
): SpaceConfig {
  if (input.url && input.space) {
    throw new ValidationError(
      `"--space" cannot be provided when using "--url".`,
      { exitCode: 1 },
    );
  }

  if (!input.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }

  const output: Partial<PieceConfig> = {
    identity: absPath(input.identity),
  };
  if (input.json) output.jsonOutput = true;

  if (input.url) {
    const { apiUrl, space, piece, pieceScope } = parseUrl(input.url);
    output.apiUrl = apiUrl;
    output.space = space;
    output.piece = piece;
    if (pieceScope) output.pieceScope = pieceScope;
    return output as PieceConfig;
  }

  if (!input.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }
  if (!input.space) {
    throw new ValidationError(
      `Missing required option: "--space".`,
      { exitCode: 1 },
    );
  }

  if (input.piece) {
    // Do not validate here -- piece is only
    // required via `parsePieceOptions`
    const parsedPiece = parseScopedIdSegment(input.piece);
    output.piece = parsedPiece.id;
    if (parsedPiece.scope) output.pieceScope = parsedPiece.scope;
  }

  output.apiUrl = normalizeApiUrl(input.apiUrl);
  output.space = input.space;

  if (!input.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CF_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  return output as PieceConfig;
}

export function parseLink(
  ref: string,
  _options?: { allowWellKnown?: boolean },
): { pieceId: string; scope?: CellScope; path?: (string | number)[] } {
  const parts = ref.split("/");
  if (parts.length < 1) {
    throw new ValidationError(
      `Invalid reference format. Expected: pieceId or pieceId/path/to/field`,
      { exitCode: 1 },
    );
  }

  const parsedPiece = parseScopedIdSegment(parts[0]);
  const pieceId = parsedPiece.id;

  if (parts.length === 1) {
    // If this is a well-known ID (no path) and allowWellKnown is not explicitly true,
    // we might want to handle it differently in the future
    return { pieceId, ...(parsedPiece.scope && { scope: parsedPiece.scope }) };
  }

  const path = parseCellPath(parts.slice(1).join("/"));
  return {
    pieceId,
    ...(parsedPiece.scope && { scope: parsedPiece.scope }),
    path,
  };
}

function parseUrl(
  input: string,
): { apiUrl: string; space: string; piece?: string; pieceScope?: CellScope } {
  let url;
  try {
    url = new URL(input);
  } catch (_) {
    throw new ValidationError(
      `"--url" "${input}" is not a URL.`,
      { exitCode: 1 },
    );
  }
  const apiUrl = `${url.protocol}//${url.host}`;
  const [space, piece] = url.pathname.split("/").filter(Boolean);
  if (!space) {
    throw new ValidationError(
      `"--url" does not contain a space.`,
      { exitCode: 1 },
    );
  }
  if (!piece) return { apiUrl, space };
  const parsedPiece = parseScopedIdSegment(piece);
  return {
    apiUrl,
    space,
    piece: parsedPiece.id,
    ...(parsedPiece.scope && { pieceScope: parsedPiece.scope }),
  };
}

// We use stdin for piece input which must be an `Object`
async function drainStdin(): Promise<object> {
  let out = "";
  for await (const chunk of Deno.stdin.readable) {
    out += decode(chunk);
  }
  try {
    return JSON.parse(out);
  } catch (_e) {
    throw new Error(`Could not parse STDIN as JSON: "${out}".`);
  }
}
