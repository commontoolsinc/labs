// cell-bridge.ts — Bridge PieceManager → FsTree
//
// Populates the filesystem tree with piece data from Common Tools spaces.
// Supports multiple spaces with on-demand connection.
// Subscribes to cell changes and rebuilds subtrees on updates.

import { FsTree } from "./tree.ts";
import { buildJsonTree, isSigilLink } from "./tree-builder.ts";
import type { PieceManager } from "@commontools/piece";
import { type PieceController, PiecesController } from "@commontools/piece/ops";

/** Strip "of:" prefix from entity IDs if present. */
function stripOfPrefix(id: string): string {
  return id.startsWith("of:") ? id.slice(3) : id;
}

type Cancel = () => void;

/** Callback to invalidate kernel cache entries. */
export type InvalidateCallback = (parentIno: bigint, names: string[]) => void;

/** Per-space state after connection. */
export interface SpaceState {
  manager: PieceManager;
  spaceIno: bigint;
  piecesIno: bigint;
  entitiesIno: bigint;
  pieceMap: Map<string, string>; // name → entity ID
  did: string;
  unsubscribes: Cancel[];
}

export class CellBridge {
  tree: FsTree;
  spaces: Map<string, SpaceState> = new Map();
  /** Known space name → DID mapping (for .spaces.json). */
  knownSpaces: Map<string, string> = new Map();
  /** Callback for kernel cache invalidation (set by mod.ts after mount). */
  onInvalidate: InvalidateCallback | null = null;
  private identity: string = "";
  private apiUrl: string = "";
  private connecting: Set<string> = new Set();
  // deno-lint-ignore no-explicit-any
  private loadManager: ((config: any) => Promise<PieceManager>) | null = null;

  constructor(tree: FsTree) {
    this.tree = tree;
  }

  async init(config: {
    apiUrl: string;
    identity: string;
  }): Promise<void> {
    this.apiUrl = config.apiUrl;
    this.identity = config.identity;
    // Dynamic import — CLI lib isn't a published export, use relative path
    const mod = await import("../cli/lib/piece.ts");
    this.loadManager = mod.loadManager;
  }

  /** Connect to a space and populate its tree. */
  async connectSpace(spaceName: string): Promise<SpaceState> {
    // Return existing if already connected
    const existing = this.spaces.get(spaceName);
    if (existing) return existing;

    // Prevent duplicate concurrent connections
    if (this.connecting.has(spaceName)) {
      // Wait for the in-progress connection
      while (this.connecting.has(spaceName)) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const state = this.spaces.get(spaceName);
      if (state) return state;
      throw new Error(`Space "${spaceName}" failed to connect`);
    }

    this.connecting.add(spaceName);
    try {
      if (!this.loadManager) {
        throw new Error("CellBridge not initialized");
      }

      const manager = await this.loadManager({
        apiUrl: this.apiUrl,
        space: spaceName,
        identity: this.identity,
      });

      const state = await this.buildSpaceTree(spaceName, manager);
      this.spaces.set(spaceName, state);
      this.knownSpaces.set(spaceName, state.did);
      this.updateSpacesJson();
      return state;
    } finally {
      this.connecting.delete(spaceName);
    }
  }

  isConnecting(spaceName: string): boolean {
    return this.connecting.has(spaceName);
  }

  /** Update the root .spaces.json file. */
  private updateSpacesJson(): void {
    const obj: Record<string, string> = {};
    for (const [name, did] of this.knownSpaces) {
      obj[name] = did;
    }

    // Remove existing .spaces.json if present, then recreate
    const existingIno = this.tree.lookup(this.tree.rootIno, ".spaces.json");
    if (existingIno !== undefined) {
      this.tree.clear(existingIno);
    }
    this.tree.addFile(
      this.tree.rootIno,
      ".spaces.json",
      JSON.stringify(obj, null, 2),
      "object",
    );
  }

  private async buildSpaceTree(
    spaceName: string,
    manager: PieceManager,
  ): Promise<SpaceState> {
    const pieces = new PiecesController(manager);

    // Create space directory structure
    const spaceIno = this.tree.addDir(this.tree.rootIno, spaceName);
    const piecesIno = this.tree.addDir(spaceIno, "pieces");
    const entitiesIno = this.tree.addDir(spaceIno, "entities");

    // space.json: DID + name
    const spaceDid = manager.getSpace();
    this.tree.addFile(
      spaceIno,
      "space.json",
      JSON.stringify({ did: spaceDid, name: spaceName }, null, 2),
      "object",
    );

    // Fetch all pieces
    const allPieces = await pieces.getAllPieces();
    console.log(`[${spaceName}] Found ${allPieces.length} pieces`);

    // Track name → entity ID and subscription cleanup
    const pieceMap = new Map<string, string>();
    const unsubscribes: Cancel[] = [];

    for (const piece of allPieces) {
      const name = piece.name() || piece.id;
      const entityHash = stripOfPrefix(piece.id);
      pieceMap.set(name, piece.id);

      const pieceIno = await this.loadPieceTree(
        piece,
        piecesIno,
        name,
        spaceName,
      );

      // entities/<entity-hash> → ../pieces/<name>
      this.tree.addSymlink(entitiesIno, entityHash, `../pieces/${name}`);

      // Subscribe to cell changes
      const subs = await this.subscribePiece(
        piece,
        pieceIno,
        name,
        spaceName,
      );
      unsubscribes.push(...subs);
    }

    // pieces/.index.json: name → entity ID mapping
    const indexObj: Record<string, string> = {};
    for (const [name, id] of pieceMap) {
      indexObj[name] = id;
    }
    this.tree.addFile(
      piecesIno,
      ".index.json",
      JSON.stringify(indexObj, null, 2),
      "object",
    );

    return {
      manager,
      spaceIno,
      piecesIno,
      entitiesIno,
      pieceMap,
      did: spaceDid,
      unsubscribes,
    };
  }

  /**
   * Subscribe to input and result cell changes for a piece.
   * On change, rebuilds the affected subtree and invalidates kernel cache.
   */
  private async subscribePiece(
    piece: PieceController,
    pieceIno: bigint,
    pieceName: string,
    spaceName: string,
  ): Promise<Cancel[]> {
    const cancels: Cancel[] = [];
    const resolveLink = this.makeLinkResolver(spaceName);

    const subscribeProp = async (
      propName: "input" | "result",
    ): Promise<void> => {
      try {
        const cell = await piece[propName].getCell();
        const cancel = cell.sink((newValue: unknown) => {
          // Clear existing subtree for this prop
          const existingIno = this.tree.lookup(pieceIno, propName);
          if (existingIno !== undefined) {
            this.tree.clear(existingIno);
          }
          // Also clear the .json sibling
          const jsonIno = this.tree.lookup(pieceIno, `${propName}.json`);
          if (jsonIno !== undefined) {
            this.tree.clear(jsonIno);
          }

          // Rebuild
          if (newValue !== undefined && newValue !== null) {
            buildJsonTree(
              this.tree,
              pieceIno,
              propName,
              newValue,
              undefined,
              resolveLink,
              0,
            );
          }

          // Invalidate kernel cache
          if (this.onInvalidate) {
            this.onInvalidate(pieceIno, [propName, `${propName}.json`]);
          }

          console.log(
            `[${spaceName}] Updated ${pieceName}/${propName}`,
          );
        });
        cancels.push(cancel);
      } catch (e) {
        console.error(
          `[${spaceName}] Could not subscribe to ${pieceName}.${propName}: ${e}`,
        );
      }
    };

    await subscribeProp("input");
    await subscribeProp("result");

    return cancels;
  }

  /**
   * Create a link resolver closure for a piece.
   *
   * Given a sigil link value and the current depth from the piece root,
   * returns a relative symlink target path:
   *
   *   Same-space + id:  "../".repeat(depth+2) + "entities/<hash>[/<path>]"
   *   Cross-space:      "../".repeat(depth+3) + "<spaceName>/entities/<hash>[/<path>]"
   *   Self-ref (no id): relative path within the same piece
   */
  private makeLinkResolver(
    spaceName: string,
  ): (value: unknown, depth: number) => string | null {
    return (value: unknown, depth: number): string | null => {
      if (!isSigilLink(value)) return null;

      const inner = (value as Record<string, unknown>)["/"] as Record<
        string,
        unknown
      >;
      const linkData = inner["link@1"] as {
        id?: string;
        path?: readonly string[];
        space?: string;
      };

      const pathSuffix = linkData.path?.length
        ? "/" + linkData.path.join("/")
        : "";

      if (!linkData.id) {
        // Self-reference: just the path relative to piece root
        return linkData.path?.length ? linkData.path.join("/") : null;
      }

      const entityHash = stripOfPrefix(linkData.id);
      // depth is relative to the piece dir (input/ or result/ adds 1)
      // We need to go up to the space dir: up from current depth + up past piece name + up past "pieces"
      const upToSpace = "../".repeat(depth + 2);

      if (linkData.space && linkData.space !== spaceName) {
        // Cross-space: go up to mount root, then into other space
        return upToSpace + "../" + linkData.space + "/entities/" + entityHash +
          pathSuffix;
      }

      // Same-space: go up to space dir, then into entities/
      return upToSpace + "entities/" + entityHash + pathSuffix;
    };
  }

  private async loadPieceTree(
    piece: PieceController,
    parentIno: bigint,
    name: string,
    spaceName: string,
  ): Promise<bigint> {
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
        {
          id: piece.id,
          entityId: stripOfPrefix(piece.id),
          name: piece.name() || "",
          patternName,
        },
        null,
        2,
      ),
      "object",
    );

    const resolveLink = this.makeLinkResolver(spaceName);

    try {
      // Input data
      const input = await piece.input.get();
      if (input !== undefined && input !== null) {
        buildJsonTree(
          this.tree,
          pieceIno,
          "input",
          input,
          undefined,
          resolveLink,
          0,
        );
      }

      // Result data
      const result = await piece.result.get();
      if (result !== undefined && result !== null) {
        buildJsonTree(
          this.tree,
          pieceIno,
          "result",
          result,
          undefined,
          resolveLink,
          0,
        );
      }
    } catch (e) {
      console.error(`Error loading piece "${name}": ${e}`);
      this.tree.addFile(pieceIno, "error.txt", String(e), "string");
    }

    return pieceIno;
  }
}
