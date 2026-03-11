/**
 * Bidirectional sync between a piece's items[] and a local markdown file.
 *
 * Run from labs root:
 *   deno run --allow-net --allow-ffi --allow-read --allow-write --allow-env \
 *     sync-daemon.ts ./todos.md --piece <id> -a http://localhost:8000 -s <space> -i ./claude.key
 */

import { loadManager, type SpaceConfig } from "../../cli/lib/piece.ts";
import { PiecesController } from "@commontools/piece/ops";
import type { PieceManager } from "@commontools/piece";
import { resolve } from "@std/path";

// ===== Types =====

interface Item {
  text: string;
  done: boolean;
}

interface SyncState {
  lastHash: string;
  suppressFile: boolean;
  suppressPiece: boolean;
}

// ===== Markdown Parsing / Serializing =====

const CHECKBOX_RE = /^- \[([ xX])\] (.+)$/;

function parseMarkdown(content: string): Item[] {
  const items: Item[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(CHECKBOX_RE);
    if (match) {
      items.push({
        done: match[1] !== " ",
        text: match[2],
      });
    }
  }
  return items;
}

function toMarkdown(items: Item[]): string {
  if (items.length === 0) return "";
  return items
    .map((item) => `- [${item.done ? "x" : " "}] ${item.text}`)
    .join("\n") + "\n";
}

// ===== Hashing =====

async function hashItems(items: Item[]): Promise<string> {
  const data = new TextEncoder().encode(JSON.stringify(items));
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ===== Atomic File Write =====

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = filePath + ".tmp." + Date.now() + "." +
    Math.random().toString(36).slice(2, 6);
  try {
    await Deno.writeTextFile(tmp, content);
    await Deno.rename(tmp, filePath);
  } catch {
    // Fallback to direct write if rename fails (race condition on macOS)
    await Deno.writeTextFile(filePath, content);
    try {
      await Deno.remove(tmp);
    } catch { /* already gone */ }
  }
}

// ===== Argument Parsing =====

interface Args {
  filePath: string;
  piece: string;
  apiUrl: string;
  space: string;
  identity: string;
}

function parseArgs(): Args {
  const args = Deno.args;
  if (args.length === 0) {
    console.error(
      "Usage: sync-daemon.ts <file.md> --piece <id> [-a <api-url>] [-s <space>] [-i <identity>]",
    );
    Deno.exit(1);
  }

  const filePath = resolve(args[0]);
  let piece = "";
  let apiUrl = "http://localhost:8000";
  let space = "";
  let identity = "./claude.key";

  for (let i = 1; i < args.length; i++) {
    switch (args[i]) {
      case "--piece":
      case "-p":
        piece = args[++i];
        break;
      case "--api-url":
      case "-a":
        apiUrl = args[++i];
        break;
      case "--space":
      case "-s":
        space = args[++i];
        break;
      case "--identity":
      case "-i":
        identity = args[++i];
        break;
    }
  }

  if (!piece) {
    console.error("Error: --piece <id> is required");
    Deno.exit(1);
  }
  if (!space) {
    console.error("Error: --space <name> is required");
    Deno.exit(1);
  }

  return { filePath, piece, apiUrl, space, identity };
}

// ===== Normalize items for consistent comparison =====

function normalizeItems(raw: unknown): Item[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item: any) => ({
    text: String(item?.text ?? ""),
    done: Boolean(item?.done),
  }));
}

// ===== Main =====

async function main() {
  const args = parseArgs();
  const config: SpaceConfig = {
    apiUrl: args.apiUrl,
    space: args.space,
    identity: args.identity,
  };

  console.log("Connecting to server...");
  const manager: PieceManager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(args.piece, true);

  const state: SyncState = {
    lastHash: "",
    suppressFile: false,
    suppressPiece: false,
  };

  // --- Read both sides on startup ---
  const pieceItems = normalizeItems(await piece.result.get(["items"]));
  let fileItems: Item[] = [];
  let fileExists = false;

  try {
    const content = await Deno.readTextFile(args.filePath);
    fileItems = parseMarkdown(content);
    fileExists = true;
  } catch {
    // File doesn't exist yet
  }

  if (!fileExists) {
    // File missing → create from piece data
    await atomicWrite(args.filePath, toMarkdown(pieceItems));
    console.log(
      `Created ${args.filePath} from piece data (${pieceItems.length} items)`,
    );
  } else if (pieceItems.length === 0 && fileItems.length > 0) {
    // Piece empty → seed from file
    await piece.result.set(fileItems, ["items"]);
    console.log(
      `Seeded piece from ${args.filePath} (${fileItems.length} items)`,
    );
  } else {
    // Both have data → piece wins
    await atomicWrite(args.filePath, toMarkdown(pieceItems));
    console.log(`Synced file to match piece (${pieceItems.length} items)`);
  }

  // Set initial hash
  const currentItems = normalizeItems(await piece.result.get(["items"]));
  state.lastHash = await hashItems(currentItems);

  // --- Piece → File (reactive via sink) ---
  let writing = false;
  const resultCell = await piece.result.getCell();
  const unsubscribe = resultCell.sink((value: any) => {
    if (state.suppressPiece || writing) return;

    const items = normalizeItems(value?.items);
    writing = true;
    hashItems(items).then(async (hash) => {
      try {
        if (hash === state.lastHash) return;
        state.suppressFile = true;
        try {
          await atomicWrite(args.filePath, toMarkdown(items));
          state.lastHash = hash;
          console.log(`piece → file (${items.length} items)`);
        } finally {
          state.suppressFile = false;
        }
      } catch (err) {
        console.error("piece → file error:", err);
      } finally {
        writing = false;
      }
    });
  });

  // --- File → Piece (via Deno.watchFs with debounce) ---
  const watcher = Deno.watchFs(args.filePath);
  let debounceTimer: number | undefined;

  const handleFileChange = async () => {
    if (state.suppressFile) return;

    let content: string;
    try {
      content = await Deno.readTextFile(args.filePath);
    } catch {
      return; // File may be mid-write
    }

    const items = parseMarkdown(content);
    const hash = await hashItems(items);
    if (hash === state.lastHash) return;

    state.suppressPiece = true;
    try {
      await piece.result.set(items, ["items"]);
      state.lastHash = hash;
      console.log(`file → piece (${items.length} items)`);
    } finally {
      state.suppressPiece = false;
    }
  };

  // Start watching in background
  (async () => {
    for await (const event of watcher) {
      if (event.kind === "modify" || event.kind === "create") {
        // Debounce: editors emit multiple events per save
        if (debounceTimer !== undefined) {
          clearTimeout(debounceTimer);
        }
        debounceTimer = setTimeout(handleFileChange, 300) as unknown as number;
      }
    }
  })();

  const shortId = args.piece.substring(0, 12) + "...";
  console.log(
    `\nSyncing ${args.filePath} ↔ piece ${shortId}  Ctrl+C to stop.\n`,
  );

  // --- Graceful shutdown ---
  const shutdown = () => {
    console.log("\nShutting down...");
    unsubscribe();
    watcher.close();
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    Deno.exit(0);
  };

  Deno.addSignalListener("SIGINT", shutdown);
  Deno.addSignalListener("SIGTERM", shutdown);

  // Keep process alive
  await new Promise(() => {});
}

main().catch((err) => {
  console.error("Fatal:", err);
  Deno.exit(1);
});
