import { Command, ValidationError } from "@cliffy/command";
import { Table } from "@cliffy/table";
import type { CellScope } from "@commonfabric/api";
import {
  decodePlan,
  diffPlan,
  encodePlan,
  type PatternCompatibilityReport,
  type PatternRef,
  type PieceDiffStatus,
  type PiecePatternRef,
  type PieceSelector,
  type PlanDiff,
} from "@commonfabric/piece/ops";
import type { RetargetRow } from "@commonfabric/piece/ops/bulk-retarget";
import ports from "@commonfabric/ports" with { type: "json" };
import { parseCellPath, UI } from "@commonfabric/runner";
import {
  matchLLMFriendlyLink,
  parseScopedIdSegment,
} from "@commonfabric/runner/shared";
import { decode } from "@commonfabric/utils/encoding";

import {
  type PhaseRetarget,
  readSourcePin,
  type RepairRunRequest,
  runRepair,
  runRetarget,
  runSurvey,
} from "../lib/bulk.ts";
import { addressArgument, VerbInputValidationError } from "../lib/callable.ts";
import { refuseSectionMarker } from "../lib/section-marker.ts";
import type {
  InvocationIdentity,
  InvocationOutcome,
  InvocationPhase,
} from "../lib/callable.ts";
import {
  type CellSelection,
  CellSelectionError,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import { cliCommand, cliText } from "../lib/cli-name.ts";
import type { FabricValue } from "@commonfabric/api";
import { jsonFromFabricValue } from "@commonfabric/data-model/codecs";
import { toCompactDebugString } from "@commonfabric/data-model/value-debug";

import { reservesStdoutForCommandOutput } from "../lib/json-output.ts";
import { normalizeLLMFriendlyRef } from "../lib/llm-friendly-ref.ts";
import { renderPiece } from "../lib/piece-render.ts";
import type {
  PieceDescription,
  PieceFieldDescription,
} from "../lib/piece-describe.ts";
import {
  applyPieceInput,
  checkPiecePattern,
  describePiece,
  type EntryConfig,
  executePieceCallable,
  formatViewTree,
  generateSpaceMap,
  getCellCfcLabel,
  getCellValue,
  getPieceView,
  inspectPiece,
  linkPieces,
  linkSqliteDiskSource,
  LinkValidationError,
  listPieceCallables,
  listPieces,
  listSpaceSlugs,
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
  setCellCfcLabel,
  setCellValue,
  setHomePattern,
  setPiecePattern,
  setPieceSlug,
  SpaceConfig,
  stepPiece,
} from "../lib/piece.ts";
import type {
  CachedResultField,
  ExecutedPieceCallable,
  PieceCallablesListing,
  PieceInspection,
} from "../lib/piece.ts";
import { render, safeStringify } from "../lib/render.ts";
import { newSessionId } from "../lib/session.ts";
import { parseSqliteSource } from "../lib/sqlite-source.ts";
import { absPath } from "../lib/utils.ts";

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

/** The parenthesised notes under a `cf piece verbs` listing, in print order.
 *
 * A listing can be short in two ways, and neither may be silent — the hidden
 * counts always print, and so does the report that the compiled pattern could
 * not be read. The second is not recoverable with `--all`: nothing in this
 * command can name a verb the pattern would have named.
 *
 * Held apart from the command action so the exact text a caller sees is
 * assertable without driving cliffy. */
export function verbListingNotes(
  listing: PieceCallablesListing,
  partition: { wrapper: number; deprecated: number },
  all: boolean,
): string[] {
  const notes: string[] = [];
  if (partition.wrapper + partition.deprecated > 0 && !all) {
    notes.push(
      `${partition.wrapper} wrapper, ${partition.deprecated} deprecated hidden; --all lists them`,
    );
  }
  if (listing.incomplete === "pattern-unavailable") {
    notes.push(
      "the pattern could not be read, so verbs its result type omits are missing; the verbs listed are still callable",
    );
  }
  return notes;
}

/** Every line `cf piece verbs` prints for the human-readable view, in order.
 *
 * The whole view, not a fragment of it: a caller reads the omission notes
 * against the rows above them, so a test that cannot see both together cannot
 * tell a listing that admits it is short from one that does not. */
export function verbListingLines(
  listing: PieceCallablesListing,
  all: boolean,
): string[] {
  const partition = partitionVerbListing(listing.verbs);
  const shown = all ? listing.verbs : partition.shown;
  const notes = verbListingNotes(listing, partition, all);
  // The hidden-count note rides the placeholder when there is no table to
  // hang it under; anything else would print a bare "(...)" with nothing
  // above it to qualify.
  if (shown.length === 0) {
    const hiddenNote = partition.wrapper + partition.deprecated > 0 && !all
      ? notes[0]
      : undefined;
    return [
      hiddenNote !== undefined
        ? `<no callable verbs shown> (${hiddenNote})`
        : "<no callable verbs>",
      ...notes.filter((note) => note !== hiddenNote).map((note) => `(${note})`),
    ];
  }
  // One table line per row by construction — no cell holds a newline and no
  // width is set — which is what lets each row's prose be slotted directly
  // beneath it: the verb's own doc comment, the same sentence its help page
  // opens with and `--json` carries as the row's `description`. The grid
  // stays scannable; the words ride under it rather than in a column they
  // would overflow.
  const table = Table.from([
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
  ]).toString().split("\n");
  const rows: string[] = [table[0]];
  shown.forEach((verb, at) => {
    rows.push(table[at + 1]);
    for (const line of verb.description?.split("\n") ?? []) {
      rows.push(`    ${line}`);
    }
  });
  return [
    ...(listing.pattern
      ? [`PATTERN ${formatPatternIdentity(listing.pattern)}`]
      : []),
    ...rows,
    ...notes.map((note) => `(${note})`),
  ];
}

/** The `--json` payload for `cf piece verbs`: the listing as
 * `listPieceCallables` returned it, narrowed to the rows actually shown, plus
 * the hidden counts when any row was withheld. `incomplete` rides through
 * untouched — a machine reader needs the lower-bound flag more than a human
 * does, because it has no listing text to read it off. */
export function verbListingJson(
  listing: PieceCallablesListing,
  all: boolean,
): Record<string, unknown> {
  const partition = partitionVerbListing(listing.verbs);
  const hiddenCount = partition.wrapper + partition.deprecated;
  return {
    ...listing,
    verbs: all ? listing.verbs : partition.shown,
    ...(hiddenCount > 0 && !all
      ? {
        hidden: {
          wrapper: partition.wrapper,
          deprecated: partition.deprecated,
        },
      }
      : {}),
  };
}

/** The parenthesised notes under a `cf piece describe` page, in print order.
 * The hidden-count note is the verbs listing's own; the incomplete note says
 * more here, because the page loses its purpose, state, and inputs to the
 * same failed pattern read that costs the listing its graph-only verbs. */
export function pieceDescribeNotes(
  description: PieceDescription,
  partition: { wrapper: number; deprecated: number },
  all: boolean,
): string[] {
  const notes: string[] = [];
  if (partition.wrapper + partition.deprecated > 0 && !all) {
    notes.push(
      `${partition.wrapper} wrapper, ${partition.deprecated} deprecated hidden; --all lists them`,
    );
  }
  if (description.incomplete === "pattern-unavailable") {
    notes.push(
      "the pattern could not be read, so its purpose, state, and inputs are missing, and so are verbs its result type omits; the verbs listed are still callable",
    );
  }
  return notes;
}

/** One field section — STATE or INPUTS — as `cf piece describe` prints it:
 * the label, then per field a `name  type` line with the author's prose
 * indented beneath it. An empty section prints nothing: a pattern declaring
 * no inputs has no INPUTS story to tell, and the section's absence is it. */
function fieldSectionLines(
  label: string,
  fields: PieceFieldDescription[],
): string[] {
  if (fields.length === 0) return [];
  const width = Math.max(...fields.map((field) => field.name.length));
  const lines: string[] = ["", label];
  for (const field of fields) {
    lines.push(`  ${field.name.padEnd(width)}  ${field.type}`);
    const prose = [
      ...(field.required === true ? ["Required."] : []),
      ...(field.description !== undefined ? [field.description] : []),
    ].join(" ");
    for (const line of prose === "" ? [] : prose.split("\n")) {
      lines.push(`      ${line}`);
    }
  }
  return lines;
}

/** The VERBS entries: each verb's name — marked when it is a tool, wrapper,
 * or deprecated — with its own doc comment indented beneath it, the same
 * sentence its help page prints as the summary line. */
function describedVerbLines(
  verbs: PieceCallablesListing["verbs"],
): string[] {
  const lines: string[] = [];
  for (const verb of verbs) {
    const marks = [
      ...(verb.kind === "tool" ? ["tool"] : []),
      ...(verb.tier === "wrapper" ? ["wrapper"] : []),
      ...(verb.deprecated === true ? ["deprecated"] : []),
    ];
    lines.push(
      `  ${verb.name}${marks.length > 0 ? ` (${marks.join(", ")})` : ""}`,
    );
    for (const line of verb.description?.split("\n") ?? []) {
      lines.push(`      ${line}`);
    }
  }
  return lines;
}

/** Every line `cf piece describe` prints for the human-readable view, in
 * order: a man page for one piece — name, pattern, purpose, state, inputs,
 * verbs — with every sentence the author's own.
 *
 * The whole view rather than fragments, on `verbListingLines`' reasoning: the
 * omission notes read against the sections above them. A missing STATE or
 * INPUTS section covers two states the notes tell apart — the pattern
 * declares none, or it could not be read at all. */
export function pieceDescribeLines(
  description: PieceDescription,
  all: boolean,
): string[] {
  const partition = partitionVerbListing(description.verbs);
  const shown = all ? description.verbs : partition.shown;
  const notes = pieceDescribeNotes(description, partition, all);
  const lines: string[] = [`NAME    ${description.name ?? "<unnamed>"}`];
  if (description.pattern) {
    const identity = formatPatternIdentity(description.pattern);
    const human = formatPatternRef(description.pattern);
    lines.push(
      `PATTERN ${identity}${
        human !== "<unknown>" && human !== identity ? ` (${human})` : ""
      }`,
    );
  }
  if (description.purpose !== undefined) {
    lines.push("");
    for (const line of description.purpose.split("\n")) {
      lines.push(`  ${line}`);
    }
  }
  lines.push(...fieldSectionLines("STATE", description.state ?? []));
  lines.push(...fieldSectionLines("INPUTS", description.inputs ?? []));
  lines.push("", "VERBS");
  if (shown.length === 0) {
    lines.push(
      partition.wrapper + partition.deprecated > 0 && !all
        ? "  <no callable verbs shown>"
        : "  <no callable verbs>",
    );
  } else {
    lines.push(...describedVerbLines(shown));
  }
  lines.push(...notes.map((note) => `(${note})`));
  return lines;
}

/** The `--json` payload for `cf piece describe`: the description's own
 * fields, then its verb rows partitioned by `verbListingJson` itself, so the
 * two surfaces cannot disagree about what a hidden row is. */
export function pieceDescribeJson(
  description: PieceDescription,
  all: boolean,
): Record<string, unknown> {
  const { name, purpose, state, inputs, ...listingPart } = description;
  return {
    ...(name !== undefined ? { name } : {}),
    ...(purpose !== undefined ? { purpose } : {}),
    ...(state !== undefined ? { state } : {}),
    ...(inputs !== undefined ? { inputs } : {}),
    ...verbListingJson(listingPart, all),
  };
}

/**
 * The `--- Cached Result Fields ---` section of `cf piece inspect`, without
 * the blank line that separates it from the section above.
 *
 * The `--- Result ---` block prints a live value and a cached one the same
 * way, so this section names which of the two each field is, and says what
 * instant a cached one answers for. `sourceCommit` is the commit the argument
 * document behind `--- Source (Inputs) ---` stands at. Commit numbers order
 * only when the computed cell and source document share `sourceSpace`; the
 * section identifies and refuses cross-space comparisons.
 */
export function renderCachedResultFields(
  cached: readonly CachedResultField[],
  sourceCommit: number | undefined,
  sourceSpace: string | undefined,
): string {
  const lines = ["--- Cached Result Fields ---"];
  if (cached.length === 0) {
    lines.push("  (none)");
    return lines.join("\n");
  }
  lines.push(
    "Each field below crosses computed state holding what its last committed",
    "derivation produced. Reading the field does not re-derive that state.",
  );
  for (const field of cached) {
    const spaces = new Set<string>(field.cells.map((cell) => cell.space));
    if (sourceSpace !== undefined) spaces.add(sourceSpace);
    const crossesSpaces = spaces.size > 1;
    const cellDescriptions = field.cells.map((cell) => {
      const commit = cell.derivedAtCommit === undefined
        ? "the local replica holds no commit for it"
        : `last derived at commit ${cell.derivedAtCommit}`;
      return crossesSpaces ? `${commit} in space ${cell.space}` : commit;
    });
    const cachedDescription = cellDescriptions.length === 1
      ? cellDescriptions[0]
      : `${cellDescriptions.length} computed cells: ${
        cellDescriptions.join("; ")
      }`;
    lines.push(
      `  - ${field.name}: ${cachedDescription}${
        sourceCommit === undefined
          ? ""
          : `; Source (Inputs) stands at commit ${sourceCommit}${
            crossesSpaces && sourceSpace !== undefined
              ? ` in space ${sourceSpace}`
              : ""
          }`
      }${
        crossesSpaces
          ? "; commits from different spaces cannot be compared"
          : ""
      }`,
    );
  }
  return lines.join("\n");
}

/** The human-readable output for `cf piece inspect`. */
export function renderPieceInspection(
  pieceData: PieceInspection,
  summary: boolean,
): string {
  const displayData = summary
    ? {
      ...pieceData,
      source: summarizeForDisplay(pieceData.source),
      result: summarizeForDisplay(pieceData.result),
    }
    : pieceData;

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
    if (!summary && isPlainObject) {
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

  output += `\n\n${
    renderCachedResultFields(
      pieceData.cachedResultFields,
      pieceData.sourceCommit,
      pieceData.sourceSpace,
    )
  }`;

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

  return output;
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

/** `cf piece slugs` output: one row per indexed name, the piece it resolves
 * to where it resolves to one, and the resolution's own error where it does
 * not. The error rides the JSON too — a machine reader has no table to read
 * a `<error: …>` marker off. */
export function renderSlugSummaries(
  slugs: Array<{ slug: string; piece?: string; error?: string }>,
  json: boolean,
): void {
  if (json) {
    render(
      slugs.map((entry) => ({
        slug: entry.slug,
        piece: entry.piece ?? null,
        ...(entry.error !== undefined ? { error: entry.error } : {}),
      })),
      { json: true },
    );
    return;
  }

  const rows = [
    ["SLUG", "PIECE"],
    ...slugs.map((entry) => [
      entry.slug,
      entry.error !== undefined ? `<error: ${entry.error}>` : entry.piece!,
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
    datafile?: string[];
  },
): EntryConfig {
  return {
    mainPath: absPath(mainPath),
    mainExport: options.mainExport,
    repository: options.repository,
    rootPath: options.root ? absPath(options.root) : undefined,
    testPaths: options.test?.map((path) => absPath(path)),
    dataFilePaths: options.datafile?.map((path) => absPath(path)),
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
 * the retry key, before exiting 1. A wait-bound expiry additionally writes
 * the Invocation JSON with that phase as its `status` to stdout — the same
 * machine surface as a settled call, so a script parses one shape either
 * way. A named export rather than catch-block prose because the action body
 * only runs under Cliffy and is unreachable from a unit test; the seams let
 * a test observe the exact exit contract, and the action's catch calls THIS
 * function, so what the tests observe is what a user gets.
 */
export function exitPieceCallFailure(
  observer: { finish: (end?: "settled" | "failed") => void },
  error: unknown,
  invocationId: string,
  phase: InvocationPhase,
  deps?: {
    printError?: (message: string) => void;
    render?: (text: string) => void;
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
  // past "dispatched" retries SAFELY ONLY with this same id. At-most-once
  // is per COMMIT, not per execution: a same-id retry runs the handler
  // body again and then loses the race for the receipt, so nothing
  // commits twice but effects outside the transaction repeat. A fresh id
  // loses nothing and commits a second time.
  printError(`invocation: ${invocationId} phase: ${phase}`);
  if (error instanceof WaitBoundExpired) {
    // The caller's patience expired. The handler runs in this process, so
    // the invocation may not have executed or committed — the recovery is a
    // same-id re-invoke, which the stderr message names. stdout still
    // carries the Invocation JSON with the furthest observed phase.
    (deps?.render ?? render)(
      JSON.stringify(
        invocationJson({ id: invocationId, status: phase }),
        null,
        2,
      ),
    );
  }
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
 * still holds the exact id to retry with. At-most-once is per COMMIT, not per
 * execution: the retry runs the handler body again and loses the race for the
 * receipt, so nothing commits twice while effects outside the transaction
 * repeat. Announcing once matters: a caller scraping
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
 * its transaction-local commit acknowledgment, the receipt classification,
 * and the receipt readback up to settlement — because those boundaries are
 * what the invocation actually reports; nothing new is instrumented inside
 * the runner. Every line goes to stderr so stdout stays exactly the settled
 * Invocation JSON an agent parses, and lines stream as transitions happen so
 * a failure exit keeps every span observed before the failure — `finish`
 * closes the in-flight span with the outcome that ended it: `settled`,
 * `failed`, or `detached` for a `--no-wait` exit that stopped at the commit
 * acknowledgment and skipped the readback.
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
      //
      // Written as an address argument, which is the same spelling the
      // receipt hint below uses: a caller reads the address off one command
      // and passes it to the next without taking it apart first. It stays
      // bare because the readback runs under the same configured space as
      // the call; `cf exec`, whose space comes from the mount instead,
      // prints the space-carrying canonical form.
      const ref = addressArgument(result.resultRef);
      hintOut(
        `Tool result cell: ${ref} (read it back with ` +
          `\`cf get --piece ${ref}\`)`,
        false,
      );
    }
    return;
  }
  const nextSteps = cliText(`NEXT STEPS:
  → Verify state:  cf get --piece ${piece} <path> ...
  → Full inspect:  cf piece inspect --piece ${piece} ...`);
  if (result.invocation) {
    // The machine surface for a handler invocation: stdout carries the
    // Invocation JSON — settled, or stopped at "committed" under --no-wait —
    // prose stays on stderr via hint().
    renderOut(JSON.stringify(invocationJson(result.invocation), null, 2));
    // The address the envelope published, when the runtime wrote a receipt.
    // It leads the detached next steps because it collects the outcome
    // without running the verb again, and it composes into the command named
    // beside it: the envelope publishes it as one canonical reference string,
    // which `--piece` takes back in unchanged. The scope rides inside it, so
    // reopening a user- or session-scoped receipt cannot land on the
    // space-scoped instance, a different cell (CallableResultRef).
    const receiptId = result.invocation.receipt;
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
  → Verify state:     cf get --piece ${piece} <path> ...`
            // The replay names its session through the environment rather
            // than `--invocation-session`, because a session is what keeps an
            // outcome's address out of reach of anyone who can guess a piece,
            // a verb and an id — and an argument is readable in a process
            // listing where an environment variable is not.
            : `NEXT STEPS:
  → Read the outcome: cf get --piece ${receiptId} (this call's receipt, an ordinary read — the handler does not run again)
  → Or replay it:     CF_INVOCATION_SESSION=${
              opts.invocation?.session ?? "<session>"
            } cf call --piece ${piece} --invocation ${
              opts.invocation?.id ?? "<id>"
            } ${callableName} ... (the commit is durable and the replay loses the race for the receipt, so nothing commits twice — but the handler body RUNS AGAIN, repeating effects outside its transaction, and any write it made into another space)
  → Verify state:     cf get --piece ${piece} <path> ...`,
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
 * acknowledgment plus receipt readback, optionally bounded by the caller's
 * patience (`--wait <seconds>`). `commit` (`--no-wait`) awaits the
 * transaction-local commit acknowledgment — the durable point; the handler
 * runs in THIS process, so the acknowledgment is not skippable — and skips
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
 * names the patience. A non-positive bound is refused: it would mean
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
const PIECE_OPTION_HELP =
  "The target piece: an id, slug, or canonical LLM-friendly reference " +
  "(/of:fid1:.../). A space embedded in the reference (/@did:.../of:.../) " +
  "supplies --space when the flag is absent, and must agree with it when " +
  "both are given.";
const PIECE_OPTION_PATH_HELP = `${PIECE_OPTION_HELP} A path embedded in ` +
  `the reference prefixes the positional path.`;
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
  Test:      cf call --piece <ID> -i ./claude.key -a http://localhost:${ports.toolshed} -s my-space callableName
  Inspect:   cf piece inspect --piece <ID> -i ./claude.key -a http://localhost:${ports.toolshed} -s my-space
${pieceEnvStatus()}
TIPS:
  • Use 'setsrc' for iteration, not repeated 'new' (avoids clutter)
  • After 'set', run 'step' to trigger computed value updates
  • Path format: forward slashes only (items/0/name, not items[0].name)
  • JSON values: strings need quotes: echo '"hello"' | cf set ...`);

/**
 * The target-selection surface every piece data command carries: quiet, the
 * combined URL, the API URL and identity with their environment fallbacks,
 * and the space. One function defines them for both surfaces that must
 * agree — `piece` declares them as globals its subcommands inherit, and the
 * top-level `cf get`/`cf set`/`cf call` instances carry them as their own,
 * having no parent globals to inherit — so the two spellings of a command
 * cannot drift apart in what they accept.
 */
export function targetOptions(
  // deno-lint-ignore no-explicit-any
  cmd: Command<any>,
  opts: { global: boolean },
  // deno-lint-ignore no-explicit-any
): Command<any> {
  const option = (flags: string, description: string) =>
    opts.global
      ? cmd.globalOption(flags, description)
      : cmd.option(flags, description);
  const env = (name: string, description: string) =>
    opts.global
      ? cmd.globalEnv(name, description, { prefix: "CF_" })
      : cmd.env(name, description, { prefix: "CF_" });
  option("-q,--quiet", "Suppress hints and next-step suggestions");
  option("-u,--url <url:string>", "URL representing a host, space, and piece.");
  env("CF_API_URL=<url:string>", "URL of the fabric server instance.");
  option("-a,--api-url <url:string>", "URL of the fabric server instance.");
  env("CF_IDENTITY=<path:string>", "Path to an identity keyfile.");
  option("-i,--identity <path:string>", "Path to an identity keyfile.");
  option("-s,--space <space:string>", "The space name or DID");
  return cmd;
}

/**
 * The day the `cf piece get`, `cf piece set`, and `cf piece call` spellings
 * stop working: two weeks after step 6a reached main
 * (docs/plans/cli-surface-shape.md). A literal rather than a window computed
 * at runtime, because a caller who reads the warning today and acts on it
 * next week must be told the same date both times. Step 6b removes the
 * spellings and their notices on this day.
 */
export const PIECE_DATA_SPELLING_END_DATE = "2026-08-31";

/**
 * The 6a deprecation notice for a piece-mounted data spelling. stderr and
 * never stdout: `get` and `call` reserve stdout for machine-readable
 * output, and a notice on stdout would corrupt exactly the piping scripts
 * this notice exists to migrate. Unconditional rather than behind
 * `--quiet`, because a quiet script is the caller most in need of the date.
 */
export function warnDeprecatedPieceSpelling(
  spelling: string,
  deps: { writeError?: (text: string) => void } = {},
): void {
  const writeError = deps.writeError ?? console.error;
  const short = spelling.replace(/^piece /, "");
  writeError(
    `'cf ${spelling}' is deprecated; spell it 'cf ${short}'. The ` +
      `'cf ${spelling}' spelling stops working on ` +
      `${PIECE_DATA_SPELLING_END_DATE}.`,
  );
}

/**
 * An action wrapped with the 6a notice. The `this` binding passes through
 * untouched because `call`'s action reads `this.getLiteralArgs()`.
 */
export function withDeprecatedSpellingWarning<
  // deno-lint-ignore no-explicit-any
  F extends (this: any, ...args: any[]) => unknown,
>(spelling: string, action: F): F {
  // deno-lint-ignore no-explicit-any
  return function (this: any, ...args: any[]) {
    warnDeprecatedPieceSpelling(spelling);
    return action.apply(this, args);
  } as F;
}

/**
 * The action a data-command builder mounts: the piece-mounted spelling
 * warns (step 6a), the top-level spelling does not. Decided here, on the
 * one definition both mounts share, because a per-mount implementation is
 * how the two surfaces drift — and this is the single respect in which
 * they are allowed to differ (test/piece-data-spellings.test.ts pins
 * exactly that).
 */
/**
 * An action that refuses a `--` before it runs.
 *
 * `get` and `set` have no callable section, so a marker on their line sets
 * words aside that nothing reads. `call` is not wrapped: it declares
 * `stopEarly()` and its action reads what the marker set aside, which is the
 * boundary the marker is for.
 */
export function withNoSectionMarker<
  // deno-lint-ignore no-explicit-any
  F extends (this: any, ...args: any[]) => unknown,
>(spelling: string, action: F): F {
  // deno-lint-ignore no-explicit-any
  return function (this: any, ...args: any[]) {
    refuseSectionMarker(spelling, this.getLiteralArgs());
    return action.apply(this, args);
  } as F;
}

export function dataCommandAction<
  // deno-lint-ignore no-explicit-any
  F extends (this: any, ...args: any[]) => unknown,
>(spelling: string, action: F): F {
  return spelling.startsWith("piece ")
    ? withDeprecatedSpellingWarning(spelling, action)
    : action;
}

/**
 * The one definition of `get`, mounted under `cf piece` and, through
 * {@link pieceDataCommand}, at top level as `cf get`. `spelling` is only
 * how the command names itself in its own help — and, since 6a, whether
 * its action carries the deprecation notice.
 */
// deno-lint-ignore no-explicit-any
function buildGetCommand(spelling = "piece get"): Command<any> {
  return new Command()
    .description(
      `Get a value from a piece at a specific path. Omit path to return the full result.

PATH FORMAT: Use forward slashes and numeric indices for arrays.
  ✓ items/0/name    ✓ config/db/host    ✗ items[0].name

ADDRESS: The target can sit in the first positional instead of --piece when
written as a canonical reference (it begins with "/"): cf ${spelling}
/of:fid1:.../items 0/name. A trailing #argument selects the arguments cell
the way --input does.`,
    )
    .usage(`${pieceUsage} [addressOrPath] [path]`)
    .example(
      cliText(`cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} name`),
      `Get the "name" field from piece result "${RAW_EX_COMP.piece!}".`,
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP} /of:fid1:abc.../items 0/name`,
      ),
      "Read through a positional canonical address; its embedded path applies.",
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP} '/of:fid1:abc...#argument' draft`,
      ),
      `Read the piece's arguments cell ("#argument" spells --input).`,
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} data/users/0/email --input`,
      ),
      `Get a nested field value from piece input "${RAW_EX_COMP.piece!}".`,
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP} --piece ${RAW_EX_COMP
          .piece!}@session draft`,
      ),
      `Get a value from a session-scoped piece instance.`,
    )
    .example(
      cliText(`cf ${spelling} ${EX_ID} ${EX_COMP_PIECE}`),
      `Get the full result of piece "${RAW_EX_COMP.piece!}".`,
    )
    .example(
      cliText(`cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} --step`),
      `Start, recompute, and get the result in one CLI session.`,
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} items --filter '.status == "open"'`,
      ),
      "Return only matching items from an array.",
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} items --select id,title`,
      ),
      "Project each returned item to selected fields.",
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} --select 'topic@,topic.title'`,
      ),
      "Return a field's address, and the fields asked for beside it.",
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} items ` +
          `--schema '{"type":"array","items":{"$link":true}}'`,
      ),
      "Return each item's address instead of its contents.",
    )
    .option("-c,--piece <piece:string>", PIECE_OPTION_PATH_HELP)
    .option(
      "--input",
      "Read from the piece's input cell instead of result cell (the " +
        '"#argument" reference suffix spells the same selection)',
    )
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
      "Project output to comma-separated field paths; a trailing @ asks for " +
        "a position's address, and @ alone for the source's own. An address " +
        "comes back as one reference string, which --piece takes back in",
    )
    .option(
      "--schema <schema:string>",
      "Project output with an inline JSON Schema, @file, or the --select " +
        "field list",
      // Both flags carry the one projection, so a command naming both has not
      // said which shape it wants. Refuse before the read rather than pick.
      { conflicts: ["select"] },
    )
    .arguments("[addressOrPath:string] [path:string]")
    .action(
      dataCommandAction(
        spelling,
        withNoSectionMarker(spelling, getCellValueFromCommand),
      ),
    );
}

/**
 * The one definition of `set`; see {@link buildGetCommand} for the shape.
 */
// deno-lint-ignore no-explicit-any
function buildSetCommand(spelling = "piece set"): Command<any> {
  return new Command()
    .description(
      cliText(
        `Set a value in a piece at a specific path. Reads JSON from stdin.

PATH FORMAT: Use forward slashes and numeric indices for arrays.
  ✓ items/0/name    ✓ config/db/host    ✗ items[0].name

JSON VALUES: Strings need quotes: echo '"hello"' | cf ${spelling} ...

ADDRESS: The target can sit in the first positional instead of --piece when
written as a canonical reference (it begins with "/"): a path embedded in it
counts, so cf ${spelling} /of:fid1:.../title needs no path argument. A trailing
#argument selects the arguments cell the way --input does.`,
      ),
    )
    .usage(`${pieceUsage} [addressOrPath] [path]`)
    .example(
      cliText(
        `echo '"New Name"' | cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} name`,
      ),
      `Set the "name" field in piece result "${RAW_EX_COMP.piece!}".`,
    )
    .example(
      cliText(
        `echo '{"foo": "bar"}' | cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} config --input`,
      ),
      `Set a nested object value in piece input "${RAW_EX_COMP.piece!}".`,
    )
    .example(
      cliText(
        `echo '"Milk"' | cf ${spelling} ${EX_ID} ${EX_COMP} /of:fid1:abc.../title`,
      ),
      "Write through a positional canonical address; the embedded path is the path.",
    )
    .option("-c,--piece <piece:string>", PIECE_OPTION_PATH_HELP)
    .option(
      "--input",
      "Write to the piece's input cell instead of result cell (the " +
        '"#argument" reference suffix spells the same selection)',
    )
    .arguments("[addressOrPath:string] [path:string]")
    .action(
      dataCommandAction(
        spelling,
        withNoSectionMarker(spelling, setCellValueFromCommand),
      ),
    );
}

/**
 * The one definition of `call`; see {@link buildGetCommand} for the
 * shape.
 */
// deno-lint-ignore no-explicit-any
function buildCallCommand(spelling = "piece call"): Command<any> {
  return new Command()
    .description(
      `Invoke a callable within a piece.

The callable name separates piece-call options from the callable's arguments.
Arguments after the callable use the same parser as cf exec. Use --json with an
optional inline value for complete JSON input; bare --json reads JSON from
stdin. A single positional JSON value or "-" stdin sentinel is also accepted.
Use --help --json for machine-readable schema help. Put schema-derived flags
after --. Handlers interpret piped input when no input argument is present.

ADDRESS: The target can precede the callable name instead of riding --piece
when written as a canonical reference (it begins with "/"):
cf ${spelling} /of:fid1:... addItem '{"title":"Milk"}'.`,
    )
    .usage(`${pieceUsage} [address] <callable> [input]`)
    .example(
      cliText(`cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} increment`),
      `Call the "increment" handler on piece "${RAW_EX_COMP.piece!}".`,
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} setName '{"value":"My Name"}'`,
      ),
      `Call the "setName" handler with JSON arguments on piece "${RAW_EX_COMP
        .piece!}".`,
    )
    .example(
      cliText(
        `echo '{"value":"My Name"}' | cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} setName -`,
      ),
      `Read the JSON payload from stdin ("-" is the stdin sentinel).`,
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} setName --json '{"value":"My Name"}'`,
      ),
      "Call a handler with explicit inline JSON input.",
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} search -- --query milk`,
      ),
      `Run the "search" tool using schema-derived flags after "--".`,
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP} /of:fid1:abc... addItem '{"title":"Milk"}'`,
      ),
      "Name the target as a positional canonical address before the callable.",
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} --select topic.title addTopic ` +
          `'{"title":"Ship it"}'`,
      ),
      "Return only the selected fields of the verb's result.",
    )
    .example(
      cliText(
        `cf ${spelling} ${EX_ID} ${EX_COMP_PIECE} ` +
          `--schema '{"properties":{"topic":{"$link":true}}}' addTopic ` +
          `'{"title":"Ship it"}'`,
      ),
      "Return the address of what the verb returned instead of its contents.",
    )
    .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
        "have executed or committed. Re-invoking under the same id and " +
        "session cannot commit twice — but it runs the handler body again, " +
        "so effects outside the transaction repeat. An expiry is exactly the " +
        "case where you cannot tell whether it committed.",
    )
    .option(
      "--no-wait",
      "Exit once this handling's commit is acknowledged (before the callable " +
        "name), skipping only the receipt readback: stdout reports status " +
        '"committed" plus the receipt address, so `cf get --piece <that ' +
        "address>` collects the outcome later without re-running the handler; " +
        "a call naming the same session and --invocation recovers it too, but " +
        "runs the handler body again. The handler still executes here and its " +
        "commit is durable. Handler invocations only.",
    )
    .option(
      "--show-links",
      "Annotate the Invocation JSON with a links dictionary mapping result " +
        "paths to their backing cell addresses, each one reference string " +
        "--piece takes back in (before the callable name). " +
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
    .action(dataCommandAction(spelling, async function (
      // Spelled out because this builder stands alone: the target options
      // arrive as `piece` globals on one mount and as own options on the
      // other, so neither inference sees the whole surface.
      options:
        & PieceCLIOptions
        & PieceCallReadbackFlags
        & {
          quiet?: boolean;
          verbose?: boolean;
          await?: boolean;
          wait?: number | boolean;
          invocation?: string;
          invocationSession?: string;
        },
      callableArg: string,
      ...tailArgs: string[]
    ) {
      // Positional-address intake first: it is a fact about the argv alone,
      // so a refusal here names no invocation and no phase.
      const { piece, callableName, tail } = readCallTarget(
        options,
        callableArg,
        tailArgs,
      );
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
          ...(piece !== undefined && { piece }),
          json: invocation.jsonOutput,
        });
        const result = await boundedSettlement(
          executePieceCallable(
            pieceConfig,
            callableName,
            invocation.rawArgs,
            {
              invocation: identity,
              // The verb help page names the mount that was invoked, so the
              // blessed spelling never renders usage lines teaching the
              // deprecated one — and the deprecated mount names itself,
              // beside its own notice.
              helpCommandPrefix: cliCommand(
                [...spelling.split(" "), "...", callableName],
              ),
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
        exitPieceCallFailure(observer, error, invocationId, phase);
      }
    }));
}

/**
 * A top-level instance of a piece data command: the same builder the
 * `piece` chain mounts under the same name, carrying the target options
 * itself. `cf get`, `cf set`, and `cf call` are these — one definition per
 * command, two spellings that parse and behave identically in every
 * respect but one: the piece-mounted spelling is deprecated (step 6a) and
 * its invocations print the dated stderr notice `dataCommandAction`
 * attaches, until {@link PIECE_DATA_SPELLING_END_DATE} removes it with the
 * spelling (docs/plans/cli-surface-shape.md, steps 5–6).
 */
// deno-lint-ignore no-explicit-any
export function pieceDataCommand(name: "get" | "set" | "call"): Command<any> {
  const builders = {
    get: buildGetCommand,
    set: buildSetCommand,
    call: buildCallCommand,
  };
  return targetOptions(builders[name](name), { global: false });
}

export const piece = targetOptions(
  new Command()
    .name("piece")
    .description(pieceDescription)
    .error((error, command) => {
      const args = command.getMainCommand().getRawArgs();
      if (reservesStdoutForCommandOutput(args)) {
        throw error;
      }
    })
    .default("help"),
  { global: true },
)
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
  /* piece slugs */
  .command(
    "slugs",
    "List the space's slugs and the piece each resolves to. The index " +
      "covers slugs assigned since it existed; an older slug still " +
      "resolves but is not listed.",
  )
  .usage(spaceUsage)
  .example(
    cliText(`cf piece slugs ${EX_ID} ${EX_COMP}`),
    `List the slugs of "${RAW_EX_COMP.space}".`,
  )
  .option("--json", "Output machine-readable JSON.")
  .action(listSlugsFromCommand)
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
  .option(
    "--datafile <path:string>",
    "Attach a data file to the deployed source package. Repeatable.",
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
  → Test a callable: cf call --piece ${pieceId} <callableName> ...
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
    const source = parseLink(sourceRef, { space: spaceConfig.space });
    collectEmbeddedSpace(spaceConfig, source);
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
    "--datafile <path:string>",
    "Attach a data file to the deployed source package. Repeatable.",
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
  → Test a callable: cf call --piece ${pieceConfig.piece} <callableName> ...
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
  .option("--json", "Output raw JSON data")
  .option(
    "--summary",
    "Show a compact summary: scalars only, arrays/objects replaced with type descriptors, $-prefixed internal keys omitted",
  )
  .option(
    "--pattern-identity",
    "Print the piece's source pin and nothing else — pattern identity, export symbol, current source revision, and whether the reference's source is verifiably retained — without running the piece or pulling its input, result, or link graph",
    { conflicts: ["summary"] },
  )
  .action(inspectPieceFromCommand)
  /* piece survey */
  .command(
    "survey",
    "Survey a holder's collection into a plan: one cheap read per piece, cross-checked against the piece registry (a --list survey claims no containment and is not cross-checked). Read-only.",
  )
  .usage(pieceUsage)
  .example(
    cliText(
      `cf piece survey ${EX_ID} ${EX_COMP_PIECE} --path topics --out plan.jsonl`,
    ),
    "Survey the holder's topics collection into plan.jsonl.",
  )
  .option(
    "-c,--piece <piece:string>",
    `${PIECE_OPTION_HELP} The holder whose collection is surveyed.`,
  )
  .option(
    "--path <path:string>",
    "Path to the collection inside the holder's document; segments joined with '/'.",
  )
  .option(
    "--side <side:string>",
    "Which document holds the collection: input (the default) or result.",
  )
  .option(
    "--list <piece:string>",
    "Survey this piece instead of a collection. Repeatable.",
    { collect: true, conflicts: ["piece", "path", "side"] },
  )
  .option(
    "--retarget <spec:string>",
    "Stamp a retarget onto one phase's rows, as <phase>=<main.tsx>[@rev]. A collection's members carry the path's last segment as their phase; the holder carries 'holder'. Repeatable.",
    { collect: true },
  )
  .option(
    "--root <path:string>",
    "Root directory for every --retarget source.",
  )
  .option(
    "--test <path:string>",
    "Attach a test source file to every --retarget source. Repeatable.",
    { collect: true },
  )
  .option(
    "--datafile <path:string>",
    "Attach a data file to every --retarget source. Repeatable.",
    { collect: true },
  )
  .option(
    "--main-export <symbol:string>",
    "The export every --retarget source runs, recorded as each row's symbol; the default export otherwise.",
  )
  .option(
    "--dangerously-allow-incompatible-schema",
    "Stamp allowIncompatible onto every retarget row. The apply honors only the row field, so the plan shows exactly which rows run with the compatibility gate open.",
  )
  .option(
    "--validator <path:string>",
    "A JSON-schema file each piece's result is read under; pieces that fail it are named on stderr.",
  )
  .option(
    "--diff <plan:string>",
    "Report this survey against the plan it verifies instead of emitting it: every planned piece as moved as planned, still outstanding, or moved to something the plan did not ask for. Exits nonzero unless every planned row converged.",
  )
  .option("--out <file:string>", "Write the plan to a file instead of stdout.")
  .option(
    "--json",
    "Write the full survey result as JSON to stdout instead of the plan, or the diff when --diff names a plan.",
    { conflicts: ["out"] },
  )
  .action(surveyFromCommand)
  /* piece repair */
  .command(
    "repair",
    "Run a caller-supplied fixer over the selection's stored input documents",
  )
  .usage(pieceUsage)
  .example(
    cliText(
      `cf piece repair ${EX_ID} ${EX_COMP_PIECE} --path topics --fixer fix.ts`,
    ),
    "Report what the fixer would change, writing nothing.",
  )
  .option(
    "-c,--piece <piece:string>",
    `${PIECE_OPTION_HELP} The holder whose collection is repaired.`,
  )
  .option(
    "--path <path:string>",
    "Path to the collection inside the holder's document; segments joined with '/'.",
  )
  .option(
    "--side <side:string>",
    "Which document holds the collection: input (the default) or result.",
  )
  .option(
    "--list <piece:string>",
    "Repair this piece instead of a collection. Repeatable.",
    { collect: true, conflicts: ["piece", "path", "side"] },
  )
  .option(
    "--fixer <path:string>",
    "A TypeScript module whose default export is the fixer: a pure transform from a piece's stored input document to the document it should hold.",
    { required: true },
  )
  .option(
    "--plan <file:string>",
    "Execute this plan's rows, in its order, under its document-hash preconditions.",
  )
  .option(
    "--apply",
    "Write the documents the fixer produces. Without it the run is the dry report: the exact per-piece diff, and no write at all.",
  )
  .option(
    "--out <file:string>",
    "Write the emitted plan to a file instead of stdout.",
  )
  .option(
    "--json",
    "Write the full repair report to stdout instead of the plan, in the canonical FabricValue JSON encoding — a diffed document may hold values plain JSON cannot carry.",
    { conflicts: ["out"] },
  )
  .action(repairFromCommand)
  /* piece retarget */
  .command(
    "retarget",
    "Apply a plan's retarget rows: serial, in plan order, each row's precondition proved before its write, stopping at the first failure with every unattempted piece named. Dry by default.",
  )
  .usage(spaceUsage)
  .example(
    cliText(`cf piece retarget ${EX_ID} ${EX_COMP} --plan plan.jsonl --apply`),
    "Move every piece the plan names onto the source its row resolves.",
  )
  .option(
    "--plan <file:string>",
    "The plan this run applies. It is the whole input: it names the pieces, the reference each must still be on, and the source each moves to.",
    { required: true },
  )
  .option(
    "--apply",
    "Write each row's source. Without it the run is the classification alone: where every piece stands against its own row, and no write at all.",
  )
  .option(
    "--group-size <count:integer>",
    "Pieces one session serves before it is replaced, so the warm-up amortizes while the pieces live at once stay bounded. A group boundary is a resume point.",
  )
  .option(
    "--out <file:string>",
    "Write the report to a file instead of streaming it to stdout, in the canonical FabricValue JSON encoding.",
  )
  .option(
    "--json",
    "Write the whole report to stdout as one document in the canonical FabricValue JSON encoding, instead of streaming a line per row.",
    { conflicts: ["out"] },
  )
  .action(retargetFromCommand)
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
      const target = parseLink(targetRef, { space: spaceConfig.space });
      collectEmbeddedSpace(spaceConfig, target);
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
    const source = parseLink(sourceRef, {
      allowWellKnown: true,
      space: spaceConfig.space,
    });
    const target = parseLink(targetRef, { space: spaceConfig.space });
    collectEmbeddedSpace(spaceConfig, source);
    collectEmbeddedSpace(spaceConfig, target);

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
  .command("get", buildGetCommand())
  /* piece get-label */
  .command(
    "get-label",
    `Get the effective CFC label view for a piece data path.

The returned paths are relative to the selected path. The view includes
declared, derived, and link-carried labels. Omit path to inspect the root.`,
  )
  .usage(`${pieceUsage} [path]`)
  .example(
    cliText(`cf piece get-label ${EX_ID} ${EX_COMP_PIECE} messages/0/body`),
    "Get the effective label on a nested result value.",
  )
  .example(
    cliText(`cf piece get-label ${EX_ID} ${EX_COMP_PIECE} secret --input`),
    "Get the effective label on an input value.",
  )
  .option("-c,--piece <piece:string>", PIECE_OPTION_PATH_HELP)
  .option(
    "--input",
    "Read from the piece's input cell instead of result cell (the " +
      '"#argument" reference suffix spells the same selection)',
  )
  .option(
    "--json",
    "Select JSON output explicitly. This command always outputs JSON.",
  )
  .arguments("[path:string]")
  .action(getCellCfcLabelFromCommand)
  /* piece set-label */
  .command(
    "set-label",
    cliText(`Set the declared CFC label at a piece data path from JSON on stdin.

INPUT: An object with confidentiality and/or integrity arrays, plus an optional
observes value: value, shape, enumerate, or followRef.

The command records the label through the same checked write operation used for
piece data. It never changes raw CFC metadata. Confidentiality may only become
more restrictive. An integrity update may keep or remove existing claims, but
cannot add trust. Conflicting observation classes are rejected. If observes is
omitted, an existing unambiguous class is preserved. The command returns the
updated effective label view.`),
  )
  .usage(`${pieceUsage} [path]`)
  .example(
    cliText(
      `echo '{"confidentiality":["team"]}' | cf piece set-label ${EX_ID} ${EX_COMP_PIECE} notes`,
    ),
    "Add a confidentiality requirement to a result value.",
  )
  .example(
    cliText(
      `echo '{"integrity":[],"observes":"value"}' | cf piece set-label ${EX_ID} ${EX_COMP_PIECE} draft --input`,
    ),
    "Remove declared integrity claims from an input value.",
  )
  .option("-c,--piece <piece:string>", PIECE_OPTION_PATH_HELP)
  .option(
    "--input",
    "Write to the piece's input cell instead of result cell (the " +
      '"#argument" reference suffix spells the same selection)',
  )
  .option(
    "--json",
    "Select JSON output explicitly. This command always outputs JSON.",
  )
  .arguments("[path:string]")
  .action(setCellCfcLabelFromCommand)
  /* piece set */
  .command("set", buildSetCommand())
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
  .command("call", buildCallCommand())
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
    // `cf piece call` never consults them. The same rule covers the other way
    // this listing can be short, which `verbListingNotes` prints beside them.
    if (options.json) {
      render(verbListingJson(listing, !!options.all), { json: true });
      return;
    }
    for (const line of verbListingLines(listing, !!options.all)) render(line);
    const shown = options.all
      ? listing.verbs
      : partitionVerbListing(listing.verbs).shown;
    // No rows means no per-verb help to point at.
    if (shown.length === 0) return;
    hint(
      cliText(
        `TIP: --json includes each verb's input schema; 'cf call --piece ${pieceConfig.piece} <verb> --help --json' has the full command spec.`,
      ),
    );
  })
  /* piece describe */
  .command(
    "describe",
    "Show a piece's documentation: name, purpose, state, inputs, and verbs.",
  )
  .usage(pieceUsage)
  .example(
    cliText(`cf piece describe ${EX_ID} ${EX_COMP_PIECE}`),
    `Document piece "${RAW_EX_COMP.piece!}" from its own pattern.`,
  )
  .example(
    cliText(`cf piece describe ${EX_ID} ${EX_URL} --json`),
    "Machine-readable description: purpose, fields, and verb rows.",
  )
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
  .option("--json", "Output machine-readable JSON.")
  .option(
    "--all",
    "Include wrapper-tier and deprecated verbs the default view hides. " +
      "Hidden verbs stay callable either way.",
  )
  .action(describePieceFromCommand)
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
  .option("-c,--piece <piece:string>", PIECE_OPTION_HELP)
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
  .option(
    "--datafile <path:string>",
    "Attach a data file to the deployed source package. Repeatable.",
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
    if (options.reset && options.datafile !== undefined) {
      throw new ValidationError(
        "Cannot use --datafile with --reset.",
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
  datafile?: string[];
  dangerouslyAllowIncompatibleSchema?: boolean;
  json?: boolean;
}

export interface PieceSummaryCLIOptions extends PieceCLIOptions {
  json?: boolean;
}

export interface PieceLabelCLIOptions extends PieceCLIOptions {
  input?: boolean;
  quiet?: boolean;
}

export interface PieceLabelCommandDependencies {
  getCellCfcLabel?: typeof getCellCfcLabel;
  setCellCfcLabel?: typeof setCellCfcLabel;
  drainStdin?: typeof drainStdin;
  render?: typeof render;
}

export interface PieceGetCLIOptions extends PieceLabelCLIOptions {
  step?: boolean;
  filter?: string;
  select?: string;
  schema?: string;
}

export interface PieceCellCommandDependencies {
  getCellValue?: typeof getCellValue;
  setCellValue?: typeof setCellValue;
  drainStdin?: typeof drainStdin;
  render?: typeof render;
  hint?: typeof hint;
  exitWithDataError?: typeof exitWithDataError;
}

/**
 * The `cf piece get` action: the target may ride `--piece` or sit in the
 * first positional as a canonical address ({@link readTargetPositionals}
 * decides which the positionals name), and either spelling may end in
 * `#argument`, which reads the arguments cell the way `--input` does.
 *
 * A named export with seams rather than an inline action body because action
 * bodies never execute under the unit suite (docs/development/COVERAGE.md).
 */
export async function getCellValueFromCommand(
  options: PieceGetCLIOptions,
  first?: string,
  second?: string,
  deps: PieceCellCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  const target = readTargetPositionals(options, first, second);
  const pieceConfig = {
    ...parsePieceOptions(
      target.address ? { ...options, piece: target.address } : options,
      { acceptsPath: true, acceptsArgument: true },
    ),
    jsonOutput: true,
  };
  const pathSegments = mergePiecePath(pieceConfig, target.pathString);
  const input = options.input || pieceConfig.pieceInput;
  try {
    const selection = await parseCellSelectionOptions(options);
    const value = await (deps.getCellValue ?? getCellValue)(
      pieceConfig,
      pathSegments,
      {
        input,
        step: options.step,
        ...(selection === undefined ? {} : { selection }),
      },
    );
    (deps.render ?? render)(value, { json: true });
  } catch (error) {
    // A read that fails on a data condition — the path doesn't resolve, or
    // the result schema can't project the stored data (PieceResultProjection
    // Error) — is a data error, not a usage error. Report it on stderr
    // instead of letting Cliffy dump the help screen over it.
    const report = pieceGetDataErrorReport(error, {
      input,
      piece: pieceConfig.piece,
    });
    if (report) (deps.exitWithDataError ?? exitWithDataError)(report);
    throw error;
  }
}

/**
 * The `cf piece set` action, with the same positional-address intake as
 * {@link getCellValueFromCommand}. The write needs a path spelled somewhere
 * — embedded in the address, positionally, or both — and an explicit empty
 * positional (`""`) is a spelling: it has always named the root, and the
 * fuse integration writes a whole input cell with it. What is refused is a
 * bare positional address with no path anywhere, so a pasted address cannot
 * silently overwrite a whole cell.
 */
export async function setCellValueFromCommand(
  options: PieceLabelCLIOptions,
  first?: string,
  second?: string,
  deps: PieceCellCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  const target = readTargetPositionals(options, first, second);
  const pieceConfig = parsePieceOptions(
    target.address ? { ...options, piece: target.address } : options,
    { acceptsPath: true, acceptsArgument: true },
  );
  const pathSegments = mergePiecePath(pieceConfig, target.pathString);
  if (pathSegments.length === 0 && target.pathString === undefined) {
    throw new ValidationError(
      `A path is required: embed it in the address (/of:.../title) or ` +
        `pass it as an argument ("" writes the root).`,
      { exitCode: 1 },
    );
  }
  const value = await (deps.drainStdin ?? drainStdin)();
  await (deps.setCellValue ?? setCellValue)(pieceConfig, pathSegments, value, {
    input: options.input || pieceConfig.pieceInput,
  });
  (deps.render ?? render)(`Set value at path: ${pathSegments.join("/")}`);
  (deps.hint ?? hint)(
    cliText(
      `TIP: Computed values may be stale. Run 'cf piece step --piece ${pieceConfig.piece} ...' to trigger recomputation.`,
    ),
  );
}

export async function getCellCfcLabelFromCommand(
  options: PieceLabelCLIOptions,
  pathString?: string,
  deps: PieceLabelCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  const pieceConfig = {
    ...parsePieceOptions(options, { acceptsPath: true, acceptsArgument: true }),
    jsonOutput: true,
  };
  const pathSegments = mergePiecePath(pieceConfig, pathString);
  const label = await (deps.getCellCfcLabel ?? getCellCfcLabel)(
    pieceConfig,
    pathSegments,
    { input: options.input || pieceConfig.pieceInput },
  );
  (deps.render ?? render)(label, { json: true });
}

export async function setCellCfcLabelFromCommand(
  options: PieceLabelCLIOptions,
  pathString?: string,
  deps: PieceLabelCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  const pieceConfig = {
    ...parsePieceOptions(options, { acceptsPath: true, acceptsArgument: true }),
    jsonOutput: true,
  };
  const pathSegments = mergePiecePath(pieceConfig, pathString);
  const update = await (deps.drainStdin ?? drainStdin)();
  const label = await (deps.setCellCfcLabel ?? setCellCfcLabel)(
    pieceConfig,
    pathSegments,
    update,
    { input: options.input || pieceConfig.pieceInput },
  );
  (deps.render ?? render)(label, { json: true });
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

export interface PieceInspectCommandDependencies {
  inspectPiece?: typeof inspectPiece;
  readSourcePin?: typeof readSourcePin;
  render?: typeof render;
  printError?: (message: string) => void;
  exit?: (code: number) => never;
}

export async function inspectPieceFromCommand(
  options: PieceCLIOptions & { summary?: boolean; patternIdentity?: boolean },
  deps: PieceInspectCommandDependencies = {},
): Promise<void> {
  const pieceConfig = parsePieceOptions(options);
  const print = deps.render ?? render;
  if (options.patternIdentity) {
    const pin = await (deps.readSourcePin ?? readSourcePin)(pieceConfig);
    if (pin === undefined) {
      exitWithDataError(
        { message: `Piece ${pieceConfig.piece} carries no pattern identity.` },
        deps,
      );
    }
    if (options.json) {
      print(pin, { json: true });
      return;
    }
    print(
      [
        `piece:    ${pin.piece}`,
        `identity: ${pin.patternIdentity}`,
        `symbol:   ${pin.symbol}`,
        ...(pin.revisionId === undefined
          ? []
          : [`revision: ${pin.revisionId}`]),
        `retained: ${pin.retained}`,
      ].join("\n"),
    );
    return;
  }
  const pieceData = await (deps.inspectPiece ?? inspectPiece)(pieceConfig);
  const displayData = options.summary
    ? {
      ...pieceData,
      source: summarizeForDisplay(pieceData.source),
      result: summarizeForDisplay(pieceData.result),
    }
    : pieceData;
  if (options.json) {
    print(displayData, { json: true });
    return;
  }
  print(renderPieceInspection(pieceData, options.summary === true));
}

/**
 * Parse one `--retarget` flag: `<phase>=<main>[@rev]`. The `@rev` label is
 * recorded for readers and for diffing plans, never enforced — the identity
 * computed from the source is the pin.
 */
export function parseRetargetFlag(spec: string): PhaseRetarget {
  const eq = spec.indexOf("=");
  if (eq <= 0 || eq === spec.length - 1) {
    throw new ValidationError(
      `--retarget takes <phase>=<main>[@rev], got "${spec}".`,
      { exitCode: 1 },
    );
  }
  const phase = spec.slice(0, eq);
  const rest = spec.slice(eq + 1);
  // Only an `@` after the last path separator is a rev label — paths with
  // `@`-named directories (scoped packages, vendor trees) stay whole.
  const at = rest.lastIndexOf("@");
  const usable = at > 0 && at > rest.lastIndexOf("/");
  const main = usable ? rest.slice(0, at) : rest;
  const rev = usable ? rest.slice(at + 1) : undefined;
  return {
    phase,
    source: { main: absPath(main) },
    ...(rev === undefined || rev === "" ? {} : { rev }),
  };
}

export interface SurveyCLIOptions extends BulkSelectionOptions {
  retarget?: string[];
  validator?: string;
  /** A plan this survey is reported against rather than emitted beside. */
  diff?: string;
  out?: string;
}

export interface SurveyCommandDependencies {
  runSurvey?: typeof runSurvey;
  render?: typeof render;
  readTextFile?: (path: string) => Promise<string>;
  writeTextFile?: typeof Deno.writeTextFile;
  printError?: (message: string) => void;
  printHint?: (message: string) => void;
  exit?: (code: number) => never;
}

/**
 * Each diff verdict in the words the design names it in. The three a planned
 * row can carry lead; the rest belong to a row the plan recorded without an
 * operation, or to a piece the after-survey no longer holds.
 */
const PLAN_DIFF_LABELS: Readonly<Record<PieceDiffStatus, string>> = {
  landed: "moved as planned",
  outstanding: "still outstanding",
  "moved-elsewhere": "moved to something the plan did not ask for",
  unchanged: "unchanged, with no operation planned",
  changed: "changed, with no operation planned",
  missing: "gone from the selection",
};

/** The verdicts a converged after-survey holds, and only those. */
const CONVERGED_DIFF_STATUSES: readonly PieceDiffStatus[] = [
  "landed",
  "unchanged",
];

function formatDiffRef(ref: PatternRef | undefined): string {
  return ref === undefined ? "nothing" : `${ref.patternIdentity}#${ref.symbol}`;
}

/**
 * The diff as a person reads it. All three planned verdicts print, whatever
 * their counts: "still outstanding: 0" is a fact the reader is owed, and an
 * absent line is one they would have to infer. The remaining classes print
 * only when a run produced one.
 */
export function planDiffLines(diff: PlanDiff): string[] {
  const lines = (["landed", "outstanding", "moved-elsewhere"] as const).map(
    (status) => `${PLAN_DIFF_LABELS[status]}: ${diff.counts[status]}`,
  );
  for (const status of ["unchanged", "changed", "missing"] as const) {
    if (diff.counts[status] > 0) {
      lines.push(`${PLAN_DIFF_LABELS[status]}: ${diff.counts[status]}`);
    }
  }
  if (diff.unplanned.length > 0) {
    lines.push(
      `held by the space but not by the plan: ${diff.unplanned.length}`,
    );
  }
  return lines;
}

/**
 * Every piece whose verdict is not the converged one, named with the
 * references behind it — a count of them is not something an operator can
 * act on.
 */
export function planDiffFindings(diff: PlanDiff): string[] {
  return diff.rows.filter((row) =>
    !CONVERGED_DIFF_STATUSES.includes(row.status)
  ).map((row) =>
    `${PLAN_DIFF_LABELS[row.status]}: ${row.piece} ` +
    `${formatDiffRef(row.before)} -> ${formatDiffRef(row.after)}`
  );
}

/** Whether every planned row reached what its plan asked of it. */
export function planDiffConverged(diff: PlanDiff): boolean {
  return diff.rows.every((row) => CONVERGED_DIFF_STATUSES.includes(row.status));
}

/** The selection surface the bulk piece commands share. */
export interface BulkSelectionOptions extends PieceCLIOptions {
  /** Inherited from the `piece` mount's global target options. */
  quiet?: boolean;
  path?: string;
  side?: string;
  list?: string[];
}

/**
 * Read a bulk command's selection off its flags — one function for the
 * survey and the repair, so the two cannot drift in what an address means
 * or what they refuse. A `--list` entry is either the canonical reference
 * form or the bare id; a canonical entry may embed the target space, which
 * supplies the space when `--space` is absent and must otherwise agree —
 * at parse time against a DID, through validateEmbeddedSpaces against a
 * name still to be resolved. Bulk operations read whole pieces, so a
 * scope, a path, or the #argument suffix on an entry is refused rather
 * than dropped.
 */
export function readBulkSelection(
  options: BulkSelectionOptions,
): { selector: PieceSelector; spaceConfig: SpaceConfig } {
  if (options.list !== undefined && options.list.length > 0) {
    let listSpace = options.space;
    const embedded: string[] = [];
    const entries = options.list.map((entry) => {
      const ref = normalizeLLMFriendlyRef(entry, { space: listSpace });
      if (ref === undefined) {
        // The bare alias grammar reads @ as its scope marker.
        if (entry.includes("@")) {
          throw new ValidationError(
            `A scoped piece cannot be selected for a bulk operation; drop ` +
              `the @scope suffix on ${JSON.stringify(entry)}.`,
            { exitCode: 1 },
          );
        }
        return entry;
      }
      if (ref.scope !== undefined) {
        throw new ValidationError(
          `A scoped piece cannot be selected for a bulk operation; drop ` +
            `the @scope suffix on ${JSON.stringify(entry)}.`,
          { exitCode: 1 },
        );
      }
      if (ref.path.length > 0) {
        throw new ValidationError(
          `A bulk operation reads whole pieces; drop the path on ` +
            `${JSON.stringify(entry)}.`,
          { exitCode: 1 },
        );
      }
      if (ref.input) {
        throw new ValidationError(
          `A bulk operation reads whole pieces; drop the #argument suffix ` +
            `on ${JSON.stringify(entry)}.`,
          { exitCode: 1 },
        );
      }
      if (ref.embeddedSpace !== undefined) {
        embedded.push(ref.embeddedSpace);
        // A --url names the space itself; leave the deferred check to
        // settle an entry against it rather than manufacturing a --space
        // beside it.
        if (listSpace === undefined && options.url === undefined) {
          listSpace = ref.embeddedSpace;
        }
      }
      return ref.pieceId;
    });
    const spaceConfig = parseSpaceOptions(
      listSpace === options.space ? options : { ...options, space: listSpace },
    );
    if (embedded.length > 0) {
      spaceConfig.embeddedSpaces = [
        ...(spaceConfig.embeddedSpaces ?? []),
        ...embedded,
      ];
    }
    return { selector: { kind: "list", pieces: entries }, spaceConfig };
  }
  const pieceConfig = parsePieceOptions(options);
  if (pieceConfig.pieceScope !== undefined) {
    throw new ValidationError(
      "A scoped piece cannot hold the selected collection; drop the " +
        "@scope suffix.",
      { exitCode: 1 },
    );
  }
  const path = (options.path ?? "").split("/").filter((s) => s !== "");
  if (path.length === 0) {
    throw new ValidationError(
      "--path names the collection; use --list to select pieces directly.",
      { exitCode: 1 },
    );
  }
  if (
    options.side !== undefined && options.side !== "input" &&
    options.side !== "result"
  ) {
    throw new ValidationError(
      `--side takes input or result, got "${options.side}".`,
      { exitCode: 1 },
    );
  }
  return {
    selector: {
      kind: "collection",
      holder: pieceConfig.piece,
      path,
      ...(options.side === undefined
        ? {}
        : { side: options.side as "input" | "result" }),
    },
    spaceConfig: pieceConfig,
  };
}

export async function surveyFromCommand(
  options: SurveyCLIOptions,
  deps: SurveyCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  const { selector, spaceConfig } = readBulkSelection(options);
  const shared = {
    ...(options.root === undefined ? {} : { root: absPath(options.root) }),
    ...(options.test === undefined
      ? {}
      : { testPaths: options.test.map((p) => absPath(p)) }),
    ...(options.datafile === undefined
      ? {}
      : { dataFilePaths: options.datafile.map((p) => absPath(p)) }),
    ...(options.mainExport === undefined
      ? {}
      : { mainExport: options.mainExport }),
  };
  const retargets = (options.retarget ?? []).map((spec) => {
    const parsed = parseRetargetFlag(spec);
    return { ...parsed, source: { ...parsed.source, ...shared } };
  });

  const result = await (deps.runSurvey ?? runSurvey)(spaceConfig, {
    selector,
    ...(retargets.length === 0 ? {} : { retargets }),
    ...(options.dangerouslyAllowIncompatibleSchema
      ? { allowIncompatible: true }
      : {}),
    ...(options.validator === undefined
      ? {}
      : { validatorPath: absPath(options.validator) }),
  });

  const print = deps.render ?? render;
  const printHint = deps.printHint ?? hint;
  // A diff needs an after-survey that accounts for everything, so an
  // incomplete one takes the refusal below instead of being compared: a
  // verdict from a survey that dropped a piece is not a verdict.
  const diff = options.diff === undefined || !result.complete
    ? undefined
    : diffPlan(
      decodePlan(
        await (deps.readTextFile ?? Deno.readTextFile)(absPath(options.diff)),
      ),
      result.plan,
    );
  if (options.out !== undefined) {
    // The after-survey's own plan, whatever this run reports: it is the
    // artifact the next run's diff is taken against.
    const plan = encodePlan(result.plan);
    await (deps.writeTextFile ?? Deno.writeTextFile)(options.out, plan);
    printHint(`Wrote ${result.plan.rows.length} plan rows to ${options.out}`);
  }
  if (options.json) {
    print(diff ?? result, { json: true });
  } else if (diff !== undefined) {
    for (const line of planDiffLines(diff)) print(line);
  } else if (options.out === undefined) {
    print(encodePlan(result.plan).trimEnd());
  }
  for (const address of diff?.unplanned ?? []) {
    printHint(`held by the space but not by the plan: ${address}`);
  }
  for (const entry of result.tally) {
    printHint(
      `${entry.phase}: ${entry.count} on ` +
        `${entry.patternIdentity}#${entry.symbol}`,
    );
  }
  for (const failure of result.validatorFailures) {
    printHint(`validator: ${failure.piece} ${failure.problem}`);
  }
  if (!result.complete) {
    exitWithDataError(
      {
        message: [
          "Survey is incomplete; a write stage must refuse this plan.",
          ...result.problems.map(
            (problem) => `  unreadable: ${problem.piece} ${problem.problem}`,
          ),
          ...result.outside.map(
            (outside) =>
              `  registered outside the selection: ${outside.piece} on ` +
              `${outside.patternIdentity}#${outside.symbol}`,
          ),
        ].join("\n"),
      },
      deps,
    );
  }
  if (diff !== undefined && !planDiffConverged(diff)) {
    // A verification that finds work left is not a verification, so it does
    // not exit zero. The findings ride the message rather than a hint: a
    // quiet script is the caller most in need of which pieces they are.
    exitWithDataError(
      {
        message: [
          "The after-survey is not what the plan asked for.",
          ...planDiffFindings(diff).map((finding) => `  ${finding}`),
        ].join("\n"),
      },
      deps,
    );
  }
}

export interface RepairCLIOptions extends BulkSelectionOptions {
  fixer: string;
  plan?: string;
  apply?: boolean;
  out?: string;
}

export interface RepairCommandDependencies {
  runRepair?: typeof runRepair;
  render?: typeof render;
  writeTextFile?: typeof Deno.writeTextFile;
  printError?: (message: string) => void;
  printHint?: (message: string) => void;
  exit?: (code: number) => never;
}

export async function repairFromCommand(
  options: RepairCLIOptions,
  deps: RepairCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  const { selector, spaceConfig } = readBulkSelection(options);
  const request: RepairRunRequest = {
    selector,
    fixerPath: absPath(options.fixer),
    fixerName: options.fixer,
    ...(options.plan === undefined ? {} : { planPath: absPath(options.plan) }),
    ...(options.apply === true ? { apply: true } : {}),
  };
  const report = await (deps.runRepair ?? runRepair)(spaceConfig, request);
  const print = deps.render ?? render;
  const printHint = deps.printHint ?? hint;
  if (options.json) {
    // The canonical FabricValue encoding, not a JSON.stringify: a diffed
    // document's values may be Fabric specials — bytes, a hash — that a
    // plain serializer flattens into empty shells.
    print(jsonFromFabricValue(report as unknown as FabricValue));
  } else {
    const plan = encodePlan(report.plan);
    if (options.out !== undefined) {
      await (deps.writeTextFile ?? Deno.writeTextFile)(options.out, plan);
      printHint(`Wrote ${report.plan.rows.length} plan rows to ${options.out}`);
    } else {
      print(plan.trimEnd());
    }
  }
  const tally = new Map<string, number>();
  for (const row of report.rows) {
    tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1);
  }
  printHint(
    [...tally.entries()].map(([verdict, count]) => `${verdict}: ${count}`)
      .join(" · "),
  );
  if (options.apply !== true) {
    // The dry run's product is the exact per-piece diff, so every changed
    // position renders — through the data-model's own debug stringifier,
    // which shows a Fabric special value as itself.
    for (const row of report.rows) {
      for (const change of row.changes ?? []) {
        if (change.kind === "added") {
          printHint(
            `+ ${row.piece} ${change.path} ` +
              toCompactDebugString(change.after),
          );
        } else if (change.kind === "removed") {
          printHint(
            `- ${row.piece} ${change.path} ` +
              toCompactDebugString(change.before),
          );
        } else {
          printHint(
            `~ ${row.piece} ${change.path} ` +
              `${toCompactDebugString(change.before)} -> ` +
              toCompactDebugString(change.after),
          );
        }
      }
    }
  }
  for (const row of report.rows) {
    if (row.problem !== undefined) {
      printHint(`${row.verdict}: ${row.piece} ${row.problem}`);
    }
  }
  if (!report.complete) {
    exitWithDataError(
      {
        message: [
          options.apply === true
            ? "Repair did not complete; re-running resumes it."
            : "Repair found rows it must refuse.",
          // The problem rides the message, not a hint: a quiet script is
          // the caller most in need of the why.
          ...report.rows.filter((row) =>
            row.verdict !== "conforms" && row.verdict !== "repaired" &&
            (options.apply === true || row.verdict !== "would-change")
          ).map((row) =>
            `  ${row.verdict}: ${row.piece}` +
            (row.problem === undefined ? "" : ` ${row.problem}`)
          ),
        ].join("\n"),
      },
      deps,
    );
  }
}

export interface RetargetCLIOptions extends PieceCLIOptions {
  /** Inherited from the `piece` mount's global target options. */
  quiet?: boolean;
  plan: string;
  apply?: boolean;
  groupSize?: number;
  out?: string;
}

export interface RetargetCommandDependencies {
  runRetarget?: typeof runRetarget;
  render?: typeof render;
  writeTextFile?: typeof Deno.writeTextFile;
  printError?: (message: string) => void;
  printHint?: (message: string) => void;
  exit?: (code: number) => never;
}

/**
 * One report row as a line: the verdict, the piece, its phase, what the row
 * cost, and what it broke. The cost is on the line rather than in a summary
 * because a run whose cost per piece is unknown cannot be improved, and the
 * number has to arrive while there is still a run to reason about.
 */
export function formatRetargetRow(row: RetargetRow): string {
  return [
    row.verdict,
    row.piece,
    ...(row.phase === undefined ? [] : [row.phase]),
    ...(row.elapsedMs === undefined ? [] : [`${row.elapsedMs}ms`]),
    ...(row.problem === undefined ? [] : [`- ${row.problem}`]),
  ].join(" ");
}

/**
 * `cf piece retarget`: the plan consumer. The plan is the whole input — it
 * names the pieces, the reference each must still be on, and the source each
 * moves to — so this command carries no selection of its own. Dry by
 * default: without `--apply` the run is the classification alone.
 *
 * The report has exactly one destination. Streamed to stdout it arrives a
 * row at a time, as each row settles; written to a file or emitted as one
 * JSON document it cannot stream, and each row carries its own cost there
 * instead. Applying implies no verdict either way: the verification is
 * `cf piece survey --diff`, a separate invocation by design.
 */
export async function retargetFromCommand(
  options: RetargetCLIOptions,
  deps: RetargetCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  // Every mode reserves stdout for the report — streamed rows, one JSON
  // document, or nothing at all beside `--out` — and this run starts the
  // pieces it writes, so the runtime's console goes to stderr whether or not
  // `--json` is on the line. A pattern's own logging would otherwise land
  // between two rows of a machine-readable stream.
  const spaceConfig = { ...parseSpaceOptions(options), jsonOutput: true };
  const print = deps.render ?? render;
  const printHint = deps.printHint ?? hint;
  const streaming = options.json !== true && options.out === undefined;
  const report = await (deps.runRetarget ?? runRetarget)(spaceConfig, {
    planPath: absPath(options.plan),
    ...(options.apply === true ? { apply: true } : {}),
    ...(options.groupSize === undefined
      ? {}
      : { groupSize: options.groupSize }),
    ...(streaming
      ? { onRow: (row: RetargetRow) => print(formatRetargetRow(row)) }
      : {}),
  });
  // The canonical FabricValue encoding, as the repair's report uses: one
  // encoding for one document, whichever destination it goes to.
  const encoded = jsonFromFabricValue(report as unknown as FabricValue);
  if (options.out !== undefined) {
    await (deps.writeTextFile ?? Deno.writeTextFile)(
      options.out,
      `${encoded}\n`,
    );
    printHint(`Wrote ${report.rows.length} report rows to ${options.out}`);
  } else if (options.json) {
    print(encoded);
  }
  const tally = new Map<string, number>();
  for (const row of report.rows) {
    tally.set(row.verdict, (tally.get(row.verdict) ?? 0) + 1);
  }
  printHint(
    [
      ...[...tally.entries()].map(([verdict, count]) => `${verdict}: ${count}`),
      `written: ${report.applied}`,
    ].join(" · "),
  );
  if (!report.complete) {
    const settled = (row: RetargetRow) =>
      row.verdict === "landed" || row.verdict === "applied" ||
      (options.apply !== true && row.verdict === "outstanding");
    exitWithDataError(
      {
        message: [
          options.apply === true
            ? "Retarget did not complete; re-running resumes it."
            : "Retarget found rows an apply would refuse.",
          // The run's own trouble, as opposed to any piece's: a session that
          // would not open, would not release, or answered for another space.
          ...(report.stopReason === undefined
            ? []
            : [`  stopped: ${report.stopReason}`]),
          // Every unattempted piece by name, never a count of them: a count
          // is not something the operator of a stopped migration can act on.
          // On the message rather than a hint, for the same reason the
          // repair puts its problems there — a quiet script is the caller
          // most in need of them.
          ...report.rows.filter((row) => !settled(row)).map((row) =>
            `  ${row.verdict}: ${row.piece}` +
            (row.problem === undefined ? "" : ` ${row.problem}`)
          ),
        ].join("\n"),
      },
      deps,
    );
  }
}

export interface SlugListCommandDependencies {
  listSpaceSlugs?: typeof listSpaceSlugs;
  renderSlugSummaries?: typeof renderSlugSummaries;
}

export async function listSlugsFromCommand(
  options: PieceSummaryCLIOptions,
  deps: SlugListCommandDependencies = {},
): Promise<void> {
  const slugs = await (deps.listSpaceSlugs ?? listSpaceSlugs)(
    parseSpaceOptions(options),
  );
  (deps.renderSlugSummaries ?? renderSlugSummaries)(slugs, !!options.json);
}

export interface PieceDescribeCommandDependencies {
  describePiece?: typeof describePiece;
}

/** `cf piece describe`'s action, held apart from the cliffy chain the way
 * `listPiecesFromCommand` is: the seam is what lets a test drive the whole
 * action — quiet mode, config parse, both output shapes, and the hint —
 * without a live piece behind it. */
export async function describePieceFromCommand(
  options:
    & PieceSummaryCLIOptions
    & { piece?: string; all?: boolean; quiet?: boolean },
  deps: PieceDescribeCommandDependencies = {},
): Promise<void> {
  setQuietMode(!!options.quiet);
  const pieceConfig = parsePieceOptions(options);
  const description = await (deps.describePiece ?? describePiece)(pieceConfig);
  if (options.json) {
    render(pieceDescribeJson(description, !!options.all), { json: true });
    return;
  }
  for (const line of pieceDescribeLines(description, !!options.all)) {
    render(line);
  }
  hint(
    cliText(
      `TIP: 'cf piece verbs --piece ${pieceConfig.piece} --json' has each verb's schemas; 'cf call --piece ${pieceConfig.piece} <verb> -- --help' documents one verb.`,
    ),
  );
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

/**
 * Like `parseScopedIdSegment`, except a rejected `@scope` suffix is raised
 * as a usage error, the suffix being something the user typed.
 */
function parseScopedId(id: string): { id: string; scope?: CellScope } {
  try {
    return parseScopedIdSegment(id);
  } catch (error) {
    throw new ValidationError(
      error instanceof Error ? error.message : String(error),
      { exitCode: 1 },
    );
  }
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

export function parsePieceOptions(
  input: PieceCLIOptions,
  parseOptions?: { acceptsPath?: boolean; acceptsArgument?: boolean },
): PieceConfig {
  const options = parseSpaceOptions(input);
  if (!("piece" in options) || !options.piece) {
    throw new ValidationError(
      `Missing required option: "--piece".`,
      { exitCode: 1 },
    );
  }
  const config = options as PieceConfig;
  if (config.piecePath?.length && !parseOptions?.acceptsPath) {
    throw new ValidationError(
      `The piece reference embeds a path ("${
        config.piecePath.join("/")
      }") but this command takes a piece id only.`,
      { exitCode: 1 },
    );
  }
  if (config.pieceInput && !parseOptions?.acceptsArgument) {
    throw new ValidationError(
      `The piece reference selects the arguments cell ("#argument") but ` +
        `this command does not take "--input".`,
      { exitCode: 1 },
    );
  }
  return config;
}

/**
 * Decide what a read or write command's positionals name: an address, a
 * path, or nothing.
 *
 * The deciding grammar: a positional address is written in the canonical
 * reference form, which begins with `/` (`matchLLMFriendlyLink`), and a
 * relative cell path never does. The bare id, slug, and scoped spellings
 * stay on `--piece`, where no path competes for the position — a slug and a
 * path's first segment are indistinguishable.
 *
 * A caller naming the target twice — `--piece` beside a positional address —
 * is refused rather than resolved, the same rule `--space` beside `--url`
 * follows. So is a second positional behind a path: only an address earns a
 * path after it.
 */
export function readTargetPositionals(
  options: { piece?: string },
  first?: string,
  second?: string,
): { address?: string; pathString?: string } {
  if (first === undefined) return {};
  if (matchLLMFriendlyLink.test(first.trim())) {
    if (options.piece) {
      throw new ValidationError(
        `"--piece" cannot be provided when the address is positional.`,
        { exitCode: 1 },
      );
    }
    return {
      address: first,
      ...(second !== undefined && { pathString: second }),
    };
  }
  if (second !== undefined) {
    throw new ValidationError(
      `Unexpected argument "${second}": a second positional belongs after ` +
        `an address (/of:fid1:...), and "${first}" is a path.`,
      { exitCode: 1 },
    );
  }
  return { pathString: first };
}

/**
 * `cf piece call`'s positional intake: when the first positional is a
 * canonical address it replaces `--piece`, and the callable name follows
 * it. The same `/`-leading grammar decides as in
 * {@link readTargetPositionals}; a bare callable name can never match it.
 */
export function readCallTarget(
  options: { piece?: string },
  callableName: string,
  tail: string[],
): { piece?: string; callableName: string; tail: string[] } {
  if (!matchLLMFriendlyLink.test(callableName.trim())) {
    return { callableName, tail };
  }
  if (options.piece) {
    throw new ValidationError(
      `"--piece" cannot be provided when the address is positional.`,
      { exitCode: 1 },
    );
  }
  const [nextCallable, ...rest] = tail;
  if (nextCallable === undefined) {
    throw new ValidationError(
      `Missing argument "callable": the positional address ` +
        `"${callableName}" replaces "--piece", and the callable name ` +
        `follows it.`,
      { exitCode: 1 },
    );
  }
  return { piece: callableName, callableName: nextCallable, tail: rest };
}

// With args and env vars shadowing each other, and multiple
// ways of defining service components, we cannot make the options
// "required" with cliffy. Ensure that all required values are
// available after parsing both args and env vars.
//
// The space can arrive three ways: `--url` embeds it, `--space` names it, and
// a canonical `--piece` reference may carry it as a `/@did:.../` prefix. A
// reference's space fills an absent `--space`; a present one must agree —
// checked at parse time when the target space is a DID, and at session open
// through `validateEmbeddedSpaces` when it is a name still to be resolved.
// The piece arrives through `--piece` (or the positional address it carries)
// or inside the `--url`: a URL that names one excludes the flag, and a
// piece-less URL composes with it.
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

  // The space the piece reference below is checked against: `--space`, or
  // the space a `--url` embeds.
  let targetSpace = input.space;

  if (input.url) {
    const { apiUrl, space, piece, pieceScope } = parseUrl(input.url);
    output.apiUrl = apiUrl;
    output.space = space;
    targetSpace = space;
    if (piece) {
      // Two pieces named at once is refused rather than resolved, the same
      // rule "--space" beside "--url" follows: silently preferring either
      // one is how a caller reads a target they did not name. `input.piece`
      // may carry a positional address, so the message names both spellings.
      if (input.piece) {
        throw new ValidationError(
          `A piece reference ("--piece" or a positional address) cannot ` +
            `be provided when the "--url" names a piece.`,
          { exitCode: 1 },
        );
      }
      output.piece = piece;
      if (pieceScope) output.pieceScope = pieceScope;
      return output as PieceConfig;
    }
    // A piece-less URL supplies the host and space; the piece may still
    // arrive through "--piece" (or the positional address it carries).
  }

  if (input.piece) {
    // Do not validate here -- piece is only
    // required via `parsePieceOptions`
    const llmRef = normalizeLLMFriendlyRef(input.piece, {
      space: targetSpace,
    });
    if (llmRef) {
      output.piece = llmRef.pieceId;
      if (llmRef.scope) output.pieceScope = llmRef.scope;
      if (llmRef.path.length > 0) output.piecePath = llmRef.path;
      if (llmRef.input) output.pieceInput = true;
      if (llmRef.embeddedSpace) {
        output.embeddedSpaces = [llmRef.embeddedSpace];
        if (!targetSpace) output.space = llmRef.embeddedSpace;
      }
    } else {
      // The alias grammar has no fragments, and letting one through would
      // bury the suffix inside the id and fail as an unknown piece later.
      if (input.piece.includes("#")) {
        throw new ValidationError(
          `The "#argument" suffix rides the canonical reference form ` +
            `(/of:fid1:...#argument), not the bare piece id.`,
          { exitCode: 1 },
        );
      }
      const parsedPiece = parseScopedId(input.piece);
      output.piece = parsedPiece.id;
      if (parsedPiece.scope) output.pieceScope = parsedPiece.scope;
    }
  }

  if (input.url) return output as PieceConfig;

  if (!input.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CF_API_URL".`,
      { exitCode: 1 },
    );
  }
  if (input.space) output.space = input.space;
  if (!output.space) {
    throw new ValidationError(
      `Missing required option: "--space".`,
      { exitCode: 1 },
    );
  }

  output.apiUrl = normalizeApiUrl(input.apiUrl);
  return output as PieceConfig;
}

/**
 * Fold the space DID embedded in a parsed link reference into the command's
 * config, for the deferred check `loadPieces` runs once the session has
 * resolved the target space to a DID.
 */
function collectEmbeddedSpace(
  config: SpaceConfig,
  ref: { embeddedSpace?: string },
): void {
  if (ref.embeddedSpace === undefined) return;
  config.embeddedSpaces = [
    ...(config.embeddedSpaces ?? []),
    ref.embeddedSpace,
  ];
}

/**
 * The full path a piece data command addresses: any path embedded in an
 * LLM-friendly `--piece` reference, followed by the positional path argument.
 */
export function mergePiecePath(
  pieceConfig: PieceConfig,
  pathString?: string,
): (string | number)[] {
  return [
    ...(pieceConfig.piecePath ?? []),
    ...(pathString ? parseCellPath(pathString) : []),
  ];
}

export function parseLink(
  ref: string,
  options?: { allowWellKnown?: boolean; space?: string },
): {
  pieceId: string;
  scope?: CellScope;
  path?: (string | number)[];
  embeddedSpace?: string;
} {
  const llmRef = normalizeLLMFriendlyRef(ref, { space: options?.space });
  if (llmRef) {
    if (llmRef.input) {
      throw new ValidationError(
        `The "#argument" suffix does not apply to a link endpoint.`,
        { exitCode: 1 },
      );
    }
    return {
      pieceId: llmRef.pieceId,
      ...(llmRef.scope && { scope: llmRef.scope }),
      ...(llmRef.embeddedSpace && { embeddedSpace: llmRef.embeddedSpace }),
      ...(llmRef.path.length > 0 && { path: llmRef.path }),
    };
  }

  const parts = ref.split("/");
  if (parts.length < 1) {
    throw new ValidationError(
      `Invalid reference format. Expected: pieceId or pieceId/path/to/field`,
      { exitCode: 1 },
    );
  }

  const parsedPiece = parseScopedId(parts[0]);
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
  const parsedPiece = parseScopedId(piece);
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
