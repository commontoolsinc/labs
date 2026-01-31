import { Table } from "@cliffy/table";
import { Command, ValidationError } from "@cliffy/command";
import {
  applyPieceInput,
  callPieceHandler,
  formatViewTree,
  generateSpaceMap,
  getCellValue,
  getPieceView,
  inspectPiece,
  linkPieces,
  listPieces,
  loadManager,
  MapFormat,
  newPiece,
  PieceConfig,
  removePiece,
  savePieceRecipe,
  setCellValue,
  setPieceRecipe,
  SpaceConfig,
} from "../lib/piece.ts";
import { PiecesController } from "@commontools/piece/ops";
import { renderPiece } from "../lib/piece-render.ts";
import { render, safeStringify } from "../lib/render.ts";
import { decode } from "@commontools/utils/encoding";
import { absPath } from "../lib/utils.ts";
import { parsePath } from "@commontools/piece/ops";
import { UI } from "@commontools/runner";

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

// Override usage, since we do not "require" args that can be reflected by env vars.
const spaceUsage =
  `--identity <identity> --url <url> --api-url <api-url> --space <space>`;
const pieceUsage = `${spaceUsage} --piece <piece>`;

// Render out args for the examples for both `--url`,
// and for the individual components (`--api-url`, `--piece`, `--space`)
const RAW_EX_URL = "https://ct.dev/personal-notes/baed..43mi";
const RAW_EX_COMP = parseUrl(RAW_EX_URL);
const EX_ID = `--identity ./my.key`;
const EX_URL = `--url ${RAW_EX_URL}`;
const EX_COMP = `--api-url ${RAW_EX_COMP.apiUrl} --space ${RAW_EX_COMP.space}`;
const EX_COMP_PIECE = `${EX_COMP} --piece ${RAW_EX_COMP.piece!}`;

// Enhanced description with workflow tips
function pieceEnvStatus(): string {
  const identity = Deno.env.get("CT_IDENTITY");
  const apiUrl = Deno.env.get("CT_API_URL");
  if (!identity && !apiUrl) return "";
  const lines: string[] = ["", "ENVIRONMENT:"];
  if (identity) {
    lines.push(
      `  CT_IDENTITY = ${identity} (set, no need to pass --identity)`,
    );
  }
  if (apiUrl) {
    lines.push(
      `  CT_API_URL  = ${apiUrl} (set, no need to pass --api-url)`,
    );
  }
  return lines.join("\n");
}

const pieceDescription = `Interact with pieces running on a server.

COMMON WORKFLOWS:
  Deploy:    ct piece new ./pattern.tsx -i ./claude.key -a http://localhost:8000 -s my-space
  Update:    ct piece setsrc --piece <ID> ./pattern.tsx -i ./claude.key -a http://localhost:8000 -s my-space
  Test:      ct piece call --piece <ID> handlerName -i ./claude.key -a http://localhost:8000 -s my-space
  Inspect:   ct piece inspect --piece <ID> -i ./claude.key -a http://localhost:8000 -s my-space
${pieceEnvStatus()}
TIPS:
  • Use 'setsrc' for iteration, not repeated 'new' (avoids clutter)
  • After 'set', run 'step' to trigger computed value updates
  • Path format: forward slashes only (items/0/name, not items[0].name)
  • JSON values: strings need quotes: echo '"hello"' | ct piece set ...`;

export const piece = new Command()
  .name("piece")
  .description(pieceDescription)
  .default("help")
  .globalOption("-q,--quiet", "Suppress hints and next-step suggestions")
  .globalOption(
    "-u,--url <url:string>",
    "URL representing a host, space, and piece.",
  )
  .globalEnv("CT_API_URL=<url:string>", "URL of the fabric instance.", {
    prefix: "CT_",
  })
  .globalOption("-a,--api-url <url:string>", "URL of the fabric instance.")
  .globalEnv("CT_IDENTITY=<path:string>", "Path to an identity keyfile.", {
    prefix: "CT_",
  })
  .globalOption("-i,--identity <path:string>", "Path to an identity keyfile.")
  .globalOption("-s,--space <space:string>", "The space name or DID")
  /* piece ls */
  .command("ls", "List pieces in space.")
  .usage(spaceUsage)
  .example(
    `ct piece ls ${EX_ID} ${EX_COMP}`,
    `Display a list of all pieces in "${RAW_EX_COMP.space}".`,
  )
  .example(
    `ct piece ls ${EX_ID} ${EX_URL}`,
    `Display a list of all pieces in "${RAW_EX_COMP.space}".`,
  )
  .action(async (options) => {
    const piecesData = [
      ["ID", "NAME", "RECIPE"],
      ...((await listPieces(parseSpaceOptions(options))).map(
        (
          data,
        ) => [
          data.id,
          data.name ?? "<unnamed>",
          data.recipeName ?? "<unnamed>",
        ],
      )),
    ];
    if (piecesData.length === 1) {
      // Only header fields -- render nothing.
      return;
    }
    render(
      Table.from(piecesData).toString(),
    );
  })
  /* piece new */
  .command("new", "Create a new piece with a recipe.")
  .usage(spaceUsage)
  .example(
    `ct piece new ${EX_ID} ${EX_COMP} ./main.tsx`,
    `Create a new piece, using ./main.tsx as source.`,
  )
  .example(
    `ct piece new ${EX_ID} ${EX_URL} ./main.tsx`,
    `Create a new piece, using ./main.tsx as source.`,
  )
  .example(
    `ct piece new ${EX_ID} ${EX_COMP} --root ./patterns ./patterns/wip/main.tsx`,
    `Create a piece that can import from parent directories within ./patterns.`,
  )
  .arguments("<main:string>")
  .option("--no-start", "Only set up the piece without starting it")
  .option(
    "--main-export <export:string>",
    'Named export from entry for recipe definition. Defaults to "default".',
  )
  .option(
    "--root <path:string>",
    "Root directory for resolving imports. Allows imports from parent directories within this root.",
  )
  .action(async (options, main) => {
    setQuietMode(!!options.quiet);
    const spaceConfig = parseSpaceOptions(options);
    const pieceId = await newPiece(
      spaceConfig,
      {
        mainPath: absPath(main),
        mainExport: options.mainExport,
        rootPath: options.root ? absPath(options.root) : undefined,
      },
      { start: options.start },
    );
    render(pieceId);
    hint(`NEXT STEPS:
  → Open in browser: ${spaceConfig.apiUrl}/${spaceConfig.space}/${pieceId}
  → Update code:     ct piece setsrc --piece ${pieceId} ${main} ...
  → Test a handler:  ct piece call --piece ${pieceId} <handlerName> ...
  → Inspect state:   ct piece inspect --piece ${pieceId} ...`);
  })
  /* piece step */
  .command("step", "Run a single scheduling step: start → idle → synced → stop")
  .usage(pieceUsage)
  .example(
    `ct piece step ${EX_ID} ${EX_COMP_PIECE}`,
    `Start, wait for idle+synced, then stop piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);
    const manager = await loadManager(pieceConfig);
    const pieces = new PiecesController(manager);
    // Start in this transient runtime, wait, then stop and exit
    const piece = await pieces.get(pieceConfig.piece, true);
    await piece.getCell().pull();
    await manager.synced();
    await pieces.stop(pieceConfig.piece);
    render(`Stepped piece ${pieceConfig.piece}`);
  })
  /* piece apply */
  .command("apply", "Pass in new inputs to the target piece")
  .usage(pieceUsage)
  .example(
    `echo '{"foo":5}' | ct piece apply ${EX_ID} ${EX_COMP_PIECE}`,
    `Applies the input '{"foo":5}' to piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    `echo '{"foo":5}' | ct piece apply ${EX_ID} ${EX_URL}`,
    `Applies the input '{"foo":5}' to piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .action(async (options) =>
    applyPieceInput(parsePieceOptions(options), await drainStdin())
  )
  /* piece getsrc */
  .command("getsrc", "Retrieve the recipe source for the given piece.")
  .usage(pieceUsage)
  .example(
    `ct piece getsrc ${EX_ID} ${EX_COMP_PIECE} ./out`,
    `Retrieve the source for "${RAW_EX_COMP.piece!}" and place in ./out`,
  )
  .example(
    `ct piece getsrc ${EX_ID} ${EX_URL} ./out`,
    `Retrieve the source for "${RAW_EX_COMP.piece!}" and place in ./out`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .arguments("<outpath:string>")
  .action((options, outPath) =>
    savePieceRecipe(parsePieceOptions(options), absPath(outPath))
  )
  /* piece setsrc */
  .command("setsrc", "Update the recipe source for the given piece.")
  .usage(pieceUsage)
  .example(
    `ct piece setsrc ${EX_ID} ${EX_COMP_PIECE} ./main.tsx`,
    `Update the source for "${RAW_EX_COMP.piece!}" with ./main.tsx`,
  )
  .example(
    `ct piece setsrc ${EX_ID} ${EX_URL} ./main.tsx`,
    `Update the source for "${RAW_EX_COMP.piece!}" with ./main.tsx`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option(
    "--main-export <export:string>",
    'Named export from entry for recipe definition. Defaults to "default".',
  )
  .option(
    "--root <path:string>",
    "Root directory for resolving imports. Allows imports from parent directories within this root.",
  )
  .arguments("<main:string>")
  .action(async (options, mainPath) => {
    setQuietMode(!!options.quiet);
    const pieceConfig = parsePieceOptions(options);
    await setPieceRecipe(pieceConfig, {
      mainPath: absPath(mainPath),
      mainExport: options.mainExport,
      rootPath: options.root ? absPath(options.root) : undefined,
    });
    render(`Updated source for piece ${pieceConfig.piece}`);
    hint(`NEXT STEPS:
  → Test in browser: ${pieceConfig.apiUrl}/${pieceConfig.space}/${pieceConfig.piece}
  → Test a handler:  ct piece call --piece ${pieceConfig.piece} <handlerName> ...
  → Check state:     ct piece inspect --piece ${pieceConfig.piece} ...`);
  })
  /* piece inspect */
  .command("inspect", "Inspect detailed information about a piece")
  .usage(pieceUsage)
  .example(
    `ct piece inspect ${EX_ID} ${EX_COMP_PIECE}`,
    `Inspect detailed information about piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    `ct piece inspect ${EX_ID} ${EX_URL}`,
    `Inspect detailed information about piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--json", "Output raw JSON data")
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);

    const pieceData = await inspectPiece(pieceConfig);

    if (options.json) {
      // In JSON mode, use render with JSON output
      render(pieceData, { json: true });
      return;
    }

    // Build formatted output as template
    let output = `
=== Piece: ${pieceData.id} ===
Name: ${pieceData.name || "<no name>"}
Recipe: ${pieceData.recipeName || "<no recipe name>"}

--- Source (Inputs) ---`;

    if (pieceData.source) {
      output += `\n${safeStringify(pieceData.source)}`;
    } else {
      output += "\n<no source data>";
    }

    output += "\n\n--- Result ---";
    if (pieceData.result) {
      // Filter out large UI objects that clutter the output
      const filteredResult = { ...pieceData.result };
      if (UI in filteredResult && typeof filteredResult[UI] === "object") {
        filteredResult[UI] = "<large UI object - use --json to see full UI>";
      }
      output += `\n${safeStringify(filteredResult)}`;
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
    `ct piece view ${EX_ID} ${EX_COMP_PIECE}`,
    `Display the view for piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    `ct piece view ${EX_ID} ${EX_URL}`,
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
    `ct piece render ${EX_ID} ${EX_COMP_PIECE}`,
    `Render the UI for piece "${RAW_EX_COMP.piece!}" to HTML.`,
  )
  .example(
    `ct piece render ${EX_ID} ${EX_URL}`,
    `Render the UI for piece "${RAW_EX_COMP.piece!}" to HTML.`,
  )
  .example(
    `ct piece render ${EX_ID} ${EX_COMP_PIECE} --watch`,
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
    `ct piece link ${EX_ID} ${EX_COMP} bafypiece1/outputEmails bafypiece2/emails`,
    `Link outputEmails field from piece "bafypiece1" to emails field in piece "bafypiece2".`,
  )
  .example(
    `ct piece link ${EX_ID} ${EX_COMP} bafypiece1/data/users/0/email bafypiece2/config/primaryEmail`,
    `Link deep nested field including array access.`,
  )
  .example(
    `ct piece link ${EX_ID} ${EX_COMP} baedreiahv63wxwgaem4hzjkizl4qncfgvca7pj5cvdon7cukumfon3ioye bafypiece1/allPieces`,
    `Link well-known "allPieces" list to a piece field.`,
  )
  .arguments("<source:string> <target:string>")
  .option("--no-start", "Only link without starting the pieces")
  .action(async (options, sourceRef, targetRef) => {
    setQuietMode(!!options.quiet);
    const spaceConfig = parseSpaceOptions(options);

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

    await linkPieces(
      spaceConfig,
      source.pieceId,
      source.path || [], // Empty path for well-known IDs
      target.pieceId,
      target.path,
      { start: options.start },
    );

    render(`Linked ${sourceRef} to ${targetRef}`);
    hint(`NEXT STEPS:
  → Visualize connections: ct piece map -i ... -a ... -s ...
  → Inspect target piece:  ct piece inspect --piece ${target.pieceId} ...`);
  })
  /* piece get */
  .command(
    "get",
    `Get a value from a piece at a specific path.

PATH FORMAT: Use forward slashes and numeric indices for arrays.
  ✓ items/0/name    ✓ config/db/host    ✗ items[0].name`,
  )
  .usage(pieceUsage)
  .example(
    `ct piece get ${EX_ID} ${EX_COMP_PIECE} name`,
    `Get the "name" field from piece result "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    `ct piece get ${EX_ID} ${EX_COMP_PIECE} data/users/0/email --input`,
    `Get a nested field value from piece input "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--input", "Read from the piece's input cell instead of result cell")
  .arguments("<path:string>")
  .action(async (options, pathString) => {
    const pieceConfig = parsePieceOptions(options);
    const pathSegments = parsePath(pathString);
    const value = await getCellValue(pieceConfig, pathSegments, {
      input: options.input,
    });
    render(value, { json: true });
  })
  /* piece set */
  .command(
    "set",
    `Set a value in a piece at a specific path. Reads JSON from stdin.

PATH FORMAT: Use forward slashes and numeric indices for arrays.
  ✓ items/0/name    ✓ config/db/host    ✗ items[0].name

JSON VALUES: Strings need quotes: echo '"hello"' | ct piece set ...`,
  )
  .usage(pieceUsage)
  .example(
    `echo '"New Name"' | ct piece set ${EX_ID} ${EX_COMP_PIECE} name`,
    `Set the "name" field in piece result "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    `echo '{"foo": "bar"}' | ct piece set ${EX_ID} ${EX_COMP_PIECE} config --input`,
    `Set a nested object value in piece input "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .option("--input", "Write to the piece's input cell instead of result cell")
  .arguments("<path:string>")
  .action(async (options, pathString) => {
    setQuietMode(!!options.quiet);
    const pieceConfig = parsePieceOptions(options);
    const pathSegments = parsePath(pathString);
    const value = await drainStdin();
    await setCellValue(pieceConfig, pathSegments, value, {
      input: options.input,
    });
    render(`Set value at path: ${pathString}`);
    hint(
      `TIP: Computed values may be stale. Run 'ct piece step --piece ${pieceConfig.piece} ...' to trigger recomputation.`,
    );
  })
  /* piece map */
  .command("map", "Display a visual map of all pieces and their connections")
  .usage(spaceUsage)
  .example(
    `ct piece map ${EX_ID} ${EX_COMP}`,
    `Display a map of all pieces and connections in "${RAW_EX_COMP.space}".`,
  )
  .example(
    `ct piece map ${EX_ID} ${EX_COMP} --format dot`,
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
  .command("call", "Call a handler within a piece")
  .usage(pieceUsage)
  .example(
    `ct piece call ${EX_ID} ${EX_COMP_PIECE} increment`,
    `Call the "increment" handler on piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    `ct piece call ${EX_ID} ${EX_COMP_PIECE} setName '{"value":"My Name"}'`,
    `Call the "setName" handler with arguments on piece "${RAW_EX_COMP
      .piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .arguments("<handler:string> [args:string]")
  .action(async (options, handlerName, argsJson) => {
    setQuietMode(!!options.quiet);
    const pieceConfig = parsePieceOptions(options);
    const args = argsJson ? JSON.parse(argsJson) : await drainStdin();
    await callPieceHandler(pieceConfig, handlerName, args);
    render(`Called handler "${handlerName}" on piece ${pieceConfig.piece}`);
    hint(`NEXT STEPS:
  → Verify state:  ct piece get --piece ${pieceConfig.piece} <path> ...
  → Full inspect:  ct piece inspect --piece ${pieceConfig.piece} ...`);
  })
  /* piece rm */
  .command("rm", "Remove a piece")
  .alias("remove")
  .usage(pieceUsage)
  .example(
    `ct piece rm ${EX_ID} ${EX_COMP_PIECE}`,
    `Remove piece "${RAW_EX_COMP.piece!}".`,
  )
  .example(
    `ct piece rm ${EX_ID} ${EX_URL}`,
    `Remove piece "${RAW_EX_COMP.piece!}".`,
  )
  .option("-c,--piece <piece:string>", "The target piece ID.")
  .action(async (options) => {
    const pieceConfig = parsePieceOptions(options);
    await removePiece(pieceConfig);
    render(`Removed piece ${pieceConfig.piece}`);
  });

interface PieceCLIOptions {
  piece?: string;
  apiUrl?: string;
  identity?: string;
  space?: string;
  url?: string;
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
      `Missing required option: "--identity", or "CT_IDENTITY".`,
      { exitCode: 1 },
    );
  }

  const output: Partial<PieceConfig> = {
    identity: absPath(input.identity),
  };

  if (input.url) {
    const { apiUrl, space, piece } = parseUrl(input.url);
    output.apiUrl = apiUrl;
    output.space = space;
    output.piece = piece;
    return output as PieceConfig;
  }

  if (!input.apiUrl) {
    throw new ValidationError(
      `Missing required option: "--api-url", or "CT_API_URL".`,
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
    output.piece = input.piece;
  }

  output.apiUrl = input.apiUrl;
  output.space = input.space;

  if (!input.identity) {
    throw new ValidationError(
      `Missing required option: "--identity", or "CT_IDENTITY".`,
      { exitCode: 1 },
    );
  }
  return output as PieceConfig;
}

export function parseLink(
  ref: string,
  _options?: { allowWellKnown?: boolean },
): { pieceId: string; path?: (string | number)[] } {
  const parts = ref.split("/");
  if (parts.length < 1) {
    throw new ValidationError(
      `Invalid reference format. Expected: pieceId or pieceId/path/to/field`,
      { exitCode: 1 },
    );
  }

  const pieceId = parts[0];

  if (parts.length === 1) {
    // If this is a well-known ID (no path) and allowWellKnown is not explicitly true,
    // we might want to handle it differently in the future
    return { pieceId };
  }

  const path = parsePath(parts.slice(1).join("/"));
  return { pieceId, path };
}

function parseUrl(
  input: string,
): { apiUrl: string; space: string; piece?: string } {
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
  return { apiUrl, space, piece };
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
