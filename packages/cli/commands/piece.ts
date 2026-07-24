import { Table } from "@cliffy/table";
import { Command, ValidationError } from "@cliffy/command";
import {
  applyPieceInput,
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
  listPieces,
  MapFormat,
  newPiece,
  PieceConfig,
  PieceResultProjectionError,
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
  },
): EntryConfig {
  return {
    mainPath: absPath(mainPath),
    mainExport: options.mainExport,
    repository: options.repository,
    rootPath: options.root ? absPath(options.root) : undefined,
  };
}

/**
 * A `piece get` failure caused by a data condition rather than bad arguments:
 * a path that doesn't resolve, or a result schema that can't project the
 * stored data (PieceResultProjectionError). Reported as a plain error on
 * stderr with exit 1, never as a Cliffy ValidationError (which would dump the
 * usage screen and read as an arg-parse failure).
 */
export function isPieceGetDataError(error: unknown): error is Error {
  return error instanceof PieceResultProjectionError ||
    (error instanceof Error &&
      error.message.startsWith("Cannot access path"));
}

/**
 * Build the stderr report for a `piece get` failure. Returns null when the
 * error is not a data error (the caller should rethrow). `message` is the
 * one-line error; `hint` is an optional next-step tip. A projection error
 * already carries its own `--step` guidance, and an input-mode read has
 * nothing more to suggest — only a result-mode unresolved path gets the
 * `--input` tip.
 */
export function pieceGetDataErrorReport(
  error: unknown,
  opts: { input?: boolean; piece?: string },
): { message: string; hint?: string } | null {
  if (!isPieceGetDataError(error)) return null;
  if (error instanceof PieceResultProjectionError || opts.input) {
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
        'Pass either a payload argument (inline JSON or "-" for stdin) or ' +
          'schema-derived flags after "--", not both.',
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
    if (tail.length === 1) {
      // --json alone is a no-op: cf piece call always outputs JSON.
      // Return machine-readable schema (same as --help --json) to exit cleanly.
      return ["--help", "--json"];
    }
    // --json followed by other args: existing behavior (forward as-is).
    return ["--json"];
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
  .command("ls", "List pieces in space.")
  .usage(spaceUsage)
  .example(
    cliText(`cf piece ls ${EX_ID} ${EX_COMP}`),
    `Display a list of all pieces in "${RAW_EX_COMP.space}".`,
  )
  .example(
    cliText(`cf piece ls ${EX_ID} ${EX_URL}`),
    `Display a list of all pieces in "${RAW_EX_COMP.space}".`,
  )
  .option("--json", "Output machine-readable JSON.")
  .action(listPiecesFromCommand)
  /* piece search */
  .command("search", "Search readable input and result data in every piece.")
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
  .usage(spaceUsage)
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
  .usage(spaceUsage)
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
  .usage(pieceUsage)
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
  .usage(pieceUsage)
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
    "--dangerously-allow-incompatible-schema",
    "Replace the source even when pattern or retained-link schema compatibility cannot be proven.",
  )
  .arguments("<main:string>")
  .action(async (options, mainPath) => {
    setQuietMode(!!options.quiet);
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
        console.log("Watching for changes... Press Ctrl+C to exit.\n");

        // Initial render
        const pieceData = await inspectPiece(pieceConfig);
        console.log(`Rendering piece: ${pieceData.name || pieceConfig.piece}`);

        let renderCount = 0;
        const cleanup = await renderPiece(pieceConfig, {
          watch: true,
          start: options.start,
          onUpdate: (html) => {
            renderCount++;
            console.log(`\n--- Render #${renderCount} ---`);
            if (options.json) {
              render({ html, renderCount }, { json: true });
            } else {
              render(html);
            }
          },
        }) as () => void;

        // Handle Ctrl+C gracefully
        Deno.addSignalListener("SIGINT", () => {
          console.log("\nStopping watch mode...");
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
        render("<piece has no UI>");
      } else {
        throw error;
      }
    }
  })
  /* piece link */
  .command(
    "link",
    `Link a field from one piece to another for reactive data flow.

WELL-KNOWN IDS: System-level data (like allPieces) can be linked using
well-known IDs. See docs/common/concepts/well-known-ids.md for IDs and usage.`,
  )
  .usage(spaceUsage)
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
  .example(
    cliText(
      `cf piece link ${EX_ID} ${EX_COMP} fid1:abc123 fid1:piece1/allPieces`,
    ),
    `Link well-known "allPieces" list to a piece field.`,
  )
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
  .usage(pieceUsage)
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
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--input", "Read from the piece's input cell instead of result cell")
  .option(
    "--step",
    "Start and recompute the piece in this session before reading",
  )
  .arguments("[path:string]")
  .action(async (options, pathString) => {
    setQuietMode(!!options.quiet);
    const pieceConfig = parsePieceOptions(options);
    const pathSegments = pathString ? parseCellPath(pathString) : [];
    try {
      const value = await getCellValue(pieceConfig, pathSegments, {
        input: options.input,
        step: options.step,
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
  .usage(pieceUsage)
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
  .command("map", "Display a visual map of all pieces and their connections")
  .usage(spaceUsage)
  .example(
    cliText(`cf piece map ${EX_ID} ${EX_COMP}`),
    `Display a map of all pieces and connections in "${RAW_EX_COMP.space}".`,
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
  .command("call", "Invoke a callable within a piece")
  .usage(pieceUsage)
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
    cliText(`cf piece call ${EX_ID} ${EX_COMP_PIECE} search -- --query milk`),
    `Run the "search" tool using schema-derived flags after "--".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option(
    "--json",
    "Input/output format (JSON is the only supported format; this flag is a no-op)",
  )
  .stopEarly()
  .arguments("<callable:string> [tail...:string]")
  .action(async function (options, callableName, ...tail) {
    try {
      setQuietMode(!!options.quiet);
      const pieceConfig = parsePieceOptions(options);
      const rawArgs = pieceCallRawArgs(tail, this.getLiteralArgs());
      const result = await executePieceCallable(
        pieceConfig,
        callableName,
        rawArgs,
      );
      if (result.helpText) {
        render(result.helpText);
        return;
      }
      if (result.outputText) {
        render(result.outputText);
        if (result.resultRef) {
          // stderr, so stdout stays exactly the tool's JSON result.
          hint(
            `Tool result cell: ${result.resultRef.id} (space ${result.resultRef.space})`,
            false,
          );
        }
        return;
      }
      render(`Called handler "${callableName}" on piece ${pieceConfig.piece}`);
      hint(cliText(`NEXT STEPS:
  → Verify state:  cf piece get --piece ${pieceConfig.piece} <path> ...
  → Full inspect:  cf piece inspect --piece ${pieceConfig.piece} ...`));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(message);
      Deno.exit(1);
    }
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
  dangerouslyAllowIncompatibleSchema?: boolean;
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
