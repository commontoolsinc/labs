// cell-bridge.ts — Bridge PieceManager → FsTree
//
// Populates the filesystem tree with piece data from a Common Tools space.

import { FsTree } from "./tree.ts";
import { buildJsonTree } from "./tree-builder.ts";
import type { PieceManager } from "@commontools/piece";
import { type PieceController, PiecesController } from "@commontools/piece/ops";

interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
}

export class CellBridge {
  tree: FsTree;
  manager: PieceManager | null = null;

  constructor(tree: FsTree) {
    this.tree = tree;
  }

  async init(config: SpaceConfig): Promise<void> {
    // Dynamic import — CLI lib isn't a published export, use relative path
    const { loadManager } = await import("../cli/lib/piece.ts");
    this.manager = await loadManager(config);
  }

  async buildSpaceTree(spaceName: string): Promise<void> {
    if (!this.manager) throw new Error("CellBridge not initialized");

    const pieces = new PiecesController(this.manager);

    // Create space directory structure
    const spaceIno = this.tree.addDir(this.tree.rootIno, spaceName);
    const piecesIno = this.tree.addDir(spaceIno, "pieces");

    // Fetch all pieces
    const allPieces = await pieces.getAllPieces();
    console.log(`Found ${allPieces.length} pieces`);

    for (const piece of allPieces) {
      const name = piece.name() || piece.id;
      await this.loadPieceTree(piece, piecesIno, name);
    }
  }

  private async loadPieceTree(
    piece: PieceController,
    parentIno: bigint,
    name: string,
  ): Promise<void> {
    const pieceIno = this.tree.addDir(parentIno, name);

    // Create meta.json first so it's always present
    let patternName = "";
    try {
      const meta = await piece.getPatternMeta();
      patternName = meta?.patternName || "";
    } catch {
      // Pattern meta not always available
    }

    this.tree.addFile(
      pieceIno,
      "meta.json",
      JSON.stringify(
        { id: piece.id, name: piece.name() || "", patternName },
        null,
        2,
      ),
      "object",
    );

    try {
      // Input data
      const input = await piece.input.get();
      if (input !== undefined && input !== null) {
        buildJsonTree(this.tree, pieceIno, "input", input);
      }

      // Result data
      const result = await piece.result.get();
      if (result !== undefined && result !== null) {
        buildJsonTree(this.tree, pieceIno, "result", result);
      }
    } catch (e) {
      console.error(`Error loading piece "${name}": ${e}`);
      this.tree.addFile(pieceIno, "error.txt", String(e), "string");
    }
  }
}
