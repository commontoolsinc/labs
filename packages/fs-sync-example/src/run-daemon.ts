/**
 * Launcher script for the fs-sync daemon.
 *
 * Connects to a running toolshed, retrieves a deployed piece's argument cells,
 * and starts the bidirectional sync loop between the UI and a markdown file.
 *
 * Usage:
 *   deno run --allow-all packages/fs-sync-example/src/run-daemon.ts \
 *     --piece <PIECE_ID> \
 *     --api-url http://localhost:8210 \
 *     --identity ./claude.key \
 *     --space sync-test \
 *     --file /tmp/todos.md
 */

import { parseArgs } from "@std/cli/parse-args";
import type { Cell } from "@commonfabric/runner";
import { cellConstructorFactory } from "../../runner/src/cell.ts";
import { loadManager } from "../../cli/lib/piece.ts";
import { PiecesController } from "@commonfabric/piece/ops";
import { runSyncLoop } from "./daemon.ts";
import type { Edit, FailedEdit, Todo } from "./types.ts";

// Build a Cell constructor with .of() — must be called inside a reactive frame,
// which the daemon's doSync() provides via pushFrameFromCause.
const CellConstructor = cellConstructorFactory("cell") as unknown as {
  of: (value: unknown) => Cell<unknown>;
};

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

const args = parseArgs(Deno.args, {
  string: ["piece", "api-url", "identity", "space", "file"],
  default: {
    "api-url": "http://localhost:8210",
    "file": "/tmp/todos.md",
  },
});

const pieceId = args.piece;
const apiUrl = args["api-url"]!;
const identityPath = args.identity;
const spaceName = args.space;
const filePath = args.file!;

if (!pieceId) {
  console.error("Missing required argument: --piece <PIECE_ID>");
  Deno.exit(1);
}
if (!identityPath) {
  console.error("Missing required argument: --identity <KEY_FILE>");
  Deno.exit(1);
}
if (!spaceName) {
  console.error("Missing required argument: --space <SPACE_NAME>");
  Deno.exit(1);
}

// ---------------------------------------------------------------------------
// Bootstrap runtime and connect to piece
// ---------------------------------------------------------------------------

console.log(`Connecting to ${apiUrl}, space "${spaceName}"...`);

const manager = await loadManager({
  apiUrl,
  space: spaceName,
  identity: identityPath,
});

const pieces = new PiecesController(manager);
const piece = await pieces.get(pieceId, true);

console.log(`Connected to piece ${piece.id}`);

// Get the argument (input) cell — this is the pattern's input properties
const argCell = await piece.input.getCell();

// Extract sub-cells using .key() — these match the pattern's Input interface
const todosCell = argCell.key("todos") as unknown as Cell<Todo[]>;
const editsCell = argCell.key("edits") as unknown as Cell<Edit[]>;
const appliedEditsCell = argCell.key("appliedEdits") as unknown as Cell<
  Edit[]
>;
const failedEditsCell = argCell.key("failedEdits") as unknown as Cell<
  FailedEdit[]
>;

// ---------------------------------------------------------------------------
// Start the sync loop
// ---------------------------------------------------------------------------

console.log(`Starting sync loop: ${filePath} <-> piece ${piece.id}`);

const handle = runSyncLoop(
  manager.runtime,
  manager.getSpace(),
  todosCell,
  editsCell,
  appliedEditsCell,
  failedEditsCell,
  filePath,
  CellConstructor,
);

// Keep the process alive
const shutdown = () => {
  console.log("\nShutting down...");
  handle.dispose();
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", shutdown);
Deno.addSignalListener("SIGTERM", shutdown);

// Block forever
await new Promise(() => {});
