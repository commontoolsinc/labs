// cell-bridge.ts — Bridge PieceManager → FsTree
//
// Populates the filesystem tree with piece data from Common Tools spaces.
// Supports multiple spaces with on-demand connection.
// Subscribes to cell changes and rebuilds subtrees on updates.

import { FsTree } from "./tree.ts";
import {
  buildJsonTree,
  isHandlerCell,
  isSigilLink,
  isStreamValue,
} from "./tree-builder.ts";
import type { PieceManager } from "@commontools/piece";
import { type PieceController, PiecesController } from "@commontools/piece/ops";
// Lazy-imported in connectSpace() to avoid pulling in heavy CLI deps at import
// time (breaks tests that only use CellBridge for tree/symlink logic).
// import { loadManager } from "../cli/lib/piece.ts";

type Cancel = () => void;

/** Result of resolving an inode to a writable cell path. */
export interface WritePath {
  spaceName: string;
  pieceName: string;
  cell: "input" | "result";
  jsonPath: (string | number)[];
  isJsonFile: boolean;
  piece: PieceController;
}

/** Callback to invalidate kernel cache entries (by name under a parent). */
export type InvalidateCallback = (parentIno: bigint, names: string[]) => void;
/** Callback to invalidate cached attrs/data for an inode (forces readdir refresh). */
export type InvalidateInodeCallback = (ino: bigint) => void;

/** Per-space state after connection. */
export interface SpaceState {
  manager: PieceManager;
  pieces: PiecesController;
  spaceIno: bigint;
  piecesIno: bigint;
  entitiesIno: bigint;
  pieceMap: Map<string, string>; // name → entity ID
  pieceControllers: Map<string, PieceController>; // name → controller
  /** Per-piece subscription cancellers, keyed by piece name. */
  pieceSubs: Map<string, Cancel[]>;
  did: string;
  unsubscribes: Cancel[];
  /** Used names set for collision resolution. */
  usedNames: Set<string>;
}

export class CellBridge {
  tree: FsTree;
  spaces: Map<string, SpaceState> = new Map();
  /** Known space name → DID mapping (for .spaces.json). */
  knownSpaces: Map<string, string> = new Map();
  /** Callback for kernel cache invalidation (set by mod.ts after mount). */
  onInvalidate: InvalidateCallback | null = null;
  onInvalidateInode: InvalidateInodeCallback | null = null;
  private identity: string = "";
  private apiUrl: string = "";
  private connecting: Set<string> = new Set();
  /** Guard against concurrent syncPieceList per space. */
  private syncing: Set<string> = new Set();
  /** Flag: re-run sync after current pass completes. */
  private syncAgain: Set<string> = new Set();

  private startedAt = new Date().toISOString();
  /** Inode of the .status file (created by initStatus). */
  private statusIno: bigint | null = null;

  constructor(tree: FsTree) {
    this.tree = tree;
  }

  init(config: {
    apiUrl: string;
    identity: string;
  }): void {
    this.apiUrl = config.apiUrl;
    this.identity = config.identity;
  }

  /** Create the .status file at the mount root. Call once after init. */
  initStatus(): void {
    this.statusIno = this.tree.addFile(
      this.tree.rootIno,
      ".status",
      this.getStatusJson(),
      "object",
    );
  }

  /** Update the .status file content in the tree. */
  private updateStatus(): void {
    if (this.statusIno === null) return;
    const node = this.tree.getNode(this.statusIno);
    if (node?.kind === "file") {
      node.content = new TextEncoder().encode(this.getStatusJson());
    }
  }

  /** Generate current status as JSON. */
  private getStatusJson(): string {
    const spaces: Record<string, { did: string; pieces: number }> = {};
    for (const [name, state] of this.spaces) {
      spaces[name] = {
        did: state.did,
        pieces: state.pieceMap.size,
      };
    }
    return JSON.stringify(
      {
        apiUrl: this.apiUrl,
        startedAt: this.startedAt,
        spaces,
      },
      null,
      2,
    );
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
      const { loadManager } = await import("../cli/lib/piece.ts");
      const manager = await loadManager({
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

  /**
   * Resolve an inode to a writable cell path.
   *
   * Walks up from inode to root, collecting path segments.
   * Returns null if the inode is read-only (meta.json, space.json, etc.).
   *
   * Path structure:
   *   /<space>/pieces/<piece>/<cell>[/<json>/<path>]
   *   /<space>/pieces/<piece>/<cell>.json
   */
  resolveWritePath(ino: bigint): WritePath | null {
    // Walk up to root collecting segments
    const segments: string[] = [];
    let current = ino;
    while (current !== this.tree.rootIno) {
      const name = this.tree.getNameForIno(current);
      if (name === undefined) return null;
      segments.unshift(name);
      const parentIno = this.tree.parents.get(current);
      if (parentIno === undefined) return null;
      current = parentIno;
    }

    // segments: [spaceName, "pieces", pieceName, cell, ...jsonPath]
    // Minimum: spaceName/pieces/pieceName/cell = 4 segments
    if (segments.length < 4) return null;

    const spaceName = segments[0];
    if (segments[1] !== "pieces") return null;
    const pieceName = segments[2];

    // Read-only files
    const cellSegment = segments[3];
    if (cellSegment === "meta.json") return null;

    // Find the space and piece controller
    const space = this.spaces.get(spaceName);
    if (!space) return null;
    const piece = space.pieceControllers.get(pieceName);
    if (!piece) return null;

    // Handle .json sibling files: result.json, input.json, result/items.json
    let cell: "input" | "result";
    let jsonPath: (string | number)[];
    let isJsonFile = false;

    if (cellSegment === "input.json" || cellSegment === "result.json") {
      // Top-level .json file: replaces entire cell
      cell = cellSegment.replace(".json", "") as "input" | "result";
      jsonPath = [];
      isJsonFile = true;
    } else if (cellSegment === "input" || cellSegment === "result") {
      cell = cellSegment;
      // Remaining segments form the JSON path
      const remaining = segments.slice(4);

      // Check for .json suffix on the last segment
      if (remaining.length > 0) {
        const last = remaining[remaining.length - 1];
        if (last.endsWith(".json")) {
          remaining[remaining.length - 1] = last.slice(0, -5);
          isJsonFile = true;
        }
      }

      // Convert numeric segments to numbers for array indexing
      jsonPath = remaining.map((s) => {
        const n = Number(s);
        return Number.isInteger(n) && n >= 0 && String(n) === s ? n : s;
      });
    } else {
      // Not a recognized cell segment
      return null;
    }

    return { spaceName, pieceName, cell, jsonPath, isJsonFile, piece };
  }

  /** Send a value to a handler (stream) cell. */
  async sendToHandler(ino: bigint, value: unknown): Promise<void> {
    const node = this.tree.getNode(ino);
    if (!node || node.kind !== "handler") throw new Error("Not a handler node");

    // Walk up to collect path segments
    const segments: string[] = [];
    let current = ino;
    while (current !== this.tree.rootIno) {
      const name = this.tree.getNameForIno(current);
      if (name === undefined) throw new Error("Cannot resolve handler path");
      segments.unshift(name);
      const parentIno = this.tree.parents.get(current);
      if (parentIno === undefined) {
        throw new Error("Cannot resolve handler path");
      }
      current = parentIno;
    }

    // segments: [spaceName, "pieces", pieceName, cellProp, "key.handler"]
    if (segments.length < 5 || segments[1] !== "pieces") {
      throw new Error("Invalid handler path");
    }

    const spaceName = segments[0];
    const pieceName = segments[2];

    const space = this.spaces.get(spaceName);
    if (!space) throw new Error(`Space "${spaceName}" not found`);

    const piece = space.pieceControllers.get(pieceName);
    if (!piece) throw new Error(`Piece "${pieceName}" not found`);

    await piece[node.cellProp].set(value, [node.cellKey]);
  }

  /**
   * Parse a symlink target path relative to parentIno and extract
   * sigil link components (id, path, space).
   *
   * Returns null if the target escapes the mount root or can't be
   * mapped to a sigil link.
   */
  parseSymlinkTarget(
    parentIno: bigint,
    target: string,
  ): { id?: string; path?: string[]; space?: string } | null {
    // Get parent's absolute path segments from mount root
    const parentSegments: string[] = [];
    let current = parentIno;
    while (current !== this.tree.rootIno) {
      const name = this.tree.getNameForIno(current);
      if (name === undefined) return null;
      parentSegments.unshift(name);
      const parent = this.tree.parents.get(current);
      if (parent === undefined) return null;
      current = parent;
    }

    // Resolve target relative to parent path
    const resolved = [...parentSegments];
    for (const part of target.split("/")) {
      if (part === "" || part === ".") continue;
      if (part === "..") {
        if (resolved.length === 0) return null; // escapes mount root
        resolved.pop();
      } else {
        resolved.push(part);
      }
    }

    // Determine current space from parent's path
    const currentSpace = parentSegments.length > 0
      ? parentSegments[0]
      : undefined;

    // Match: /<space>/entities/<hash>[/<path...>]
    if (resolved.length >= 3 && resolved[1] === "entities") {
      const targetSpace = resolved[0];
      const hash = resolved[2];
      const pathParts = resolved.slice(3);

      const result: { id?: string; path?: string[]; space?: string } = {
        id: hash,
      };

      if (pathParts.length > 0) {
        result.path = pathParts;
      }

      // Omit space if same as current
      if (targetSpace !== currentSpace) {
        const did = this.knownSpaces.get(targetSpace);
        result.space = did || targetSpace;
      }

      return result;
    }

    // Self-reference: target within same piece, no entities/ segment
    // Resolved path: [space, "pieces", pieceName, cell, ...subpath]
    if (resolved.length >= 4 && resolved[1] === "pieces") {
      const subpath = resolved.slice(4);
      if (subpath.length > 0) {
        return { path: subpath };
      }
    }

    return null;
  }

  /** Write a value via the piece controller. */
  async writeValue(writePath: WritePath, value: unknown): Promise<void> {
    await writePath.piece[writePath.cell].set(
      value,
      writePath.jsonPath.length > 0 ? writePath.jsonPath : undefined,
    );
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

    const state: SpaceState = {
      manager,
      pieces,
      spaceIno,
      piecesIno,
      entitiesIno,
      pieceMap: new Map(),
      pieceControllers: new Map(),
      pieceSubs: new Map(),
      did: spaceDid,
      unsubscribes: [],
      usedNames: new Set(),
    };

    // Fetch all pieces and populate tree
    const allPieces = await pieces.getAllPieces();
    console.log(`[${spaceName}] Found ${allPieces.length} pieces`);

    for (const piece of allPieces) {
      await this.addPieceToSpace(state, piece, spaceName);
    }

    // pieces/.index.json
    this.updateIndexJson(state);

    // Subscribe to piece list changes so new/removed pieces update the tree
    const piecesCell = await manager.getPieces();
    const piecesListCancel = piecesCell.sink(() => {
      setTimeout(() => {
        this.syncPieceList(state, spaceName).catch((e) => {
          console.error(`[${spaceName}] Piece list sync error: ${e}`);
        });
      }, 0);
    });
    state.unsubscribes.push(piecesListCancel);

    this.updateStatus();
    return state;
  }

  /**
   * Resolve an entity ID under a space's entities/ directory on demand.
   * Finds the matching piece (by ID with or without "of:" prefix) and
   * builds its tree under entities/<entityId>.
   * Returns true if resolved successfully.
   */
  async resolveEntity(
    entitiesIno: bigint,
    entityId: string,
  ): Promise<boolean> {
    // Already resolved?
    if (this.tree.lookup(entitiesIno, entityId) !== undefined) return true;

    // Find the space that owns this entities/ dir
    let state: SpaceState | undefined;
    let spaceName: string | undefined;
    for (const [name, s] of this.spaces) {
      if (s.entitiesIno === entitiesIno) {
        state = s;
        spaceName = name;
        break;
      }
    }
    if (!state || !spaceName) return false;

    // Match entity ID against known pieces (with or without of: prefix)
    const bareId = entityId.startsWith("of:") ? entityId.slice(3) : entityId;
    let matchedPiece: PieceController | undefined;
    for (const [, piece] of state.pieceControllers) {
      const pieceBareid = piece.id.startsWith("of:")
        ? piece.id.slice(3)
        : piece.id;
      if (pieceBareid === bareId) {
        matchedPiece = piece;
        break;
      }
    }
    if (!matchedPiece) return false;

    // Build the piece tree under entities/<entityId> and subscribe for updates
    const pieceIno = await this.loadPieceTree(
      matchedPiece,
      entitiesIno,
      entityId,
      spaceName,
    );
    const subs = await this.subscribePiece(
      matchedPiece,
      pieceIno,
      entityId,
      spaceName,
    );
    state.pieceSubs.set(`entity:${entityId}`, subs);
    return true;
  }

  /** Check whether an inode is any space's entities/ directory. */
  isEntitiesDir(ino: bigint): boolean {
    for (const state of this.spaces.values()) {
      if (state.entitiesIno === ino) return true;
    }
    return false;
  }

  /**
   * Add a single piece to a space's tree, subscribe to its cells.
   * Returns the assigned display name.
   */
  private async addPieceToSpace(
    state: SpaceState,
    piece: PieceController,
    spaceName: string,
  ): Promise<string> {
    let name = piece.name() || piece.id;
    if (state.usedNames.has(name)) {
      let suffix = 2;
      while (state.usedNames.has(`${name}-${suffix}`)) suffix++;
      name = `${name}-${suffix}`;
    }
    state.usedNames.add(name);

    state.pieceMap.set(name, piece.id);
    state.pieceControllers.set(name, piece);

    const pieceIno = await this.loadPieceTree(
      piece,
      state.piecesIno,
      name,
      spaceName,
    );

    const subs = await this.subscribePiece(piece, pieceIno, name, spaceName);
    state.pieceSubs.set(name, subs);

    return name;
  }

  /**
   * Remove a piece from a space's tree and clean up subscriptions.
   */
  private removePieceFromSpace(state: SpaceState, name: string): void {
    // Cancel piece-level subscriptions
    const subs = state.pieceSubs.get(name);
    if (subs) {
      for (const cancel of subs) cancel();
      state.pieceSubs.delete(name);
    }

    // Remove tree nodes
    this.tree.removeChild(state.piecesIno, name);

    state.pieceMap.delete(name);
    state.pieceControllers.delete(name);
    state.usedNames.delete(name);
  }

  /**
   * Sync the piece list: diff current tree against the live pieces cell,
   * adding new pieces and removing deleted ones.
   *
   * Guarded per-space: if a sync is already running, we flag a re-run so the
   * in-flight sync will loop once more after completing (coalescing rapid
   * sink events). This prevents concurrent async interleaving from producing
   * duplicate tree entries or double-removal errors.
   */
  private async syncPieceList(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    if (this.syncing.has(spaceName)) {
      // A sync is in flight — mark for re-run when it finishes.
      this.syncAgain.add(spaceName);
      return;
    }
    this.syncing.add(spaceName);

    try {
      // Loop until no new events arrived during our sync.
      do {
        this.syncAgain.delete(spaceName);
        await this.syncPieceListOnce(state, spaceName);
      } while (this.syncAgain.has(spaceName));
    } finally {
      this.syncing.delete(spaceName);
    }
  }

  /** Single pass of piece list sync (called by guarded syncPieceList). */
  private async syncPieceListOnce(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    const allPieces = await state.pieces.getAllPieces();

    // Build set of current entity IDs
    const liveIds = new Set(allPieces.map((p) => p.id));

    // Find pieces to remove (in our tree but no longer in the live list)
    const toRemove: string[] = [];
    for (const [name, id] of state.pieceMap) {
      if (!liveIds.has(id)) toRemove.push(name);
    }

    // Find pieces to add (in the live list but not in our tree)
    const knownIds = new Set(state.pieceMap.values());
    const toAdd = allPieces.filter((p) => !knownIds.has(p.id));

    if (toRemove.length === 0 && toAdd.length === 0) return;

    for (const name of toRemove) {
      this.removePieceFromSpace(state, name);
      console.log(`[${spaceName}] Removed piece: ${name}`);
    }

    for (const piece of toAdd) {
      const name = await this.addPieceToSpace(state, piece, spaceName);
      console.log(`[${spaceName}] Added piece: ${name}`);
    }

    // Update index and invalidate
    this.updateIndexJson(state);
    if (this.onInvalidate) {
      // Invalidate child entries under pieces/
      const invalidNames = [
        ...toRemove,
        ...toAdd.map((p) => {
          for (const [n, id] of state.pieceMap) {
            if (id === p.id) return n;
          }
          return "";
        }),
        ".index.json",
      ];
      this.onInvalidate(state.piecesIno, invalidNames);
      // Also invalidate "pieces" entry on the space dir so readdir refreshes
      this.onInvalidate(state.spaceIno, ["pieces"]);
    }
    // Invalidate cached inode data for pieces dir (forces readdir refresh)
    if (this.onInvalidateInode) {
      this.onInvalidateInode(state.piecesIno);
    }
    this.updateStatus();
  }

  /** Update the pieces/.index.json file for a space. */
  private updateIndexJson(state: SpaceState): void {
    const existingIno = this.tree.lookup(state.piecesIno, ".index.json");
    if (existingIno !== undefined) {
      this.tree.clear(existingIno);
    }
    const indexObj: Record<string, string> = {};
    for (const [name, id] of state.pieceMap) {
      indexObj[name] = id;
    }
    this.tree.addFile(
      state.piecesIno,
      ".index.json",
      JSON.stringify(indexObj, null, 2),
      "object",
    );
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
    const skipEntry = (val: unknown) => isHandlerCell(val);

    const subscribeProp = async (
      propName: "input" | "result",
    ): Promise<void> => {
      try {
        const cell = await piece[propName].getCell();
        const cancel = cell.sink((newValue: unknown) => {
          // Defer the tree rebuild out of the current execution context.
          // cell.sink fires synchronously during cell.set(), which may be
          // called from within a FUSE callback (e.g. flush). Rebuilding
          // the tree and calling notify_inval_entry from inside a FUSE
          // callback crashes FUSE-T and invalidates inodes mid-operation.
          setTimeout(() => {
            try {
              // Clear existing subtree for this prop
              const existingIno = this.tree.lookup(pieceIno, propName);
              if (existingIno !== undefined) {
                this.tree.clear(existingIno);
              }
              // Also clear the .json sibling
              const jsonIno = this.tree.lookup(
                pieceIno,
                `${propName}.json`,
              );
              if (jsonIno !== undefined) {
                this.tree.clear(jsonIno);
              }

              // Rebuild
              if (newValue !== undefined && newValue !== null) {
                const propIno = buildJsonTree(
                  this.tree,
                  pieceIno,
                  propName,
                  newValue,
                  undefined,
                  resolveLink,
                  0,
                  skipEntry,
                );
                this.addHandlerFiles(propIno, newValue, propName);
              }

              // Invalidate kernel cache
              if (this.onInvalidate) {
                this.onInvalidate(pieceIno, [propName, `${propName}.json`]);
              }

              console.log(
                `[${spaceName}] Updated ${pieceName}/${propName}`,
              );
            } catch (e) {
              console.error(
                `[${spaceName}] Error rebuilding ${pieceName}/${propName}: ${e}`,
              );
            }
          }, 0);
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

      // Stream cells are rendered as .handler files, not symlinks.
      if (isHandlerCell(value)) return null;

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

      const entityHash = linkData.id;
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
          entityId: piece.id,
          name: piece.name() || "",
          patternName,
        },
        null,
        2,
      ),
      "object",
    );

    const resolveLink = this.makeLinkResolver(spaceName);
    const skipEntry = (val: unknown) => isHandlerCell(val);

    try {
      // Input data
      const input = await piece.input.get();
      if (input !== undefined && input !== null) {
        const inputIno = buildJsonTree(
          this.tree,
          pieceIno,
          "input",
          input,
          undefined,
          resolveLink,
          0,
          skipEntry,
        );
        this.addHandlerFiles(inputIno, input, "input");
      }

      // Result data
      const result = await piece.result.get();
      if (result !== undefined && result !== null) {
        const resultIno = buildJsonTree(
          this.tree,
          pieceIno,
          "result",
          result,
          undefined,
          resolveLink,
          0,
          skipEntry,
        );
        this.addHandlerFiles(resultIno, result, "result");
      }
    } catch (e) {
      console.error(`Error loading piece "${name}": ${e}`);
      this.tree.addFile(pieceIno, "error.txt", String(e), "string");
    }

    return pieceIno;
  }

  /**
   * Add .handler files for stream values and handler sigil links.
   * Called from both loadPieceTree() and subscription rebuilds.
   */
  private addHandlerFiles(
    propIno: bigint,
    value: unknown,
    cellProp: "input" | "result",
  ): void {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return;
    }
    const obj = value as Record<string, unknown>;
    for (const [key, val] of Object.entries(obj)) {
      if (isStreamValue(val) || isHandlerCell(val)) {
        this.tree.addHandler(propIno, `${key}.handler`, key, cellProp);
      }
    }
  }
}
