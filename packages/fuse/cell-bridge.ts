// cell-bridge.ts — Bridge PieceManager → FsTree
//
// Populates the filesystem tree with piece data from Common Fabric spaces.
// Supports multiple spaces with on-demand connection.
// Subscribes to cell changes and rebuilds subtrees on updates.

import type { Cell, PatternMeta } from "@commonfabric/runner";
import { schemaToTypeString } from "@commonfabric/runner";
import { FsTree } from "./tree.ts";
import {
  buildCallableScript,
  type CallableKind,
  classifyCallableEntry,
  isHandlerCell,
} from "./callables.ts";
import { parseMountedCallablePath } from "./callable-path.ts";
import {
  buildFsProjection,
  buildJsonTree,
  buildJsonTreeAsync,
  type FsValue,
  isSigilLink,
  isVNode,
  safeStringify,
} from "./tree-builder.ts";
import type { JSONSchema } from "@commonfabric/api";
import type { PieceManager } from "@commonfabric/piece";
import type {
  PieceController,
  PiecesController,
} from "@commonfabric/piece/ops";

/** Strip asStream/asCell markers from a schema for display as input schema. */
function getInputSchema(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  const { asStream: _s, asCell: _c, ...rest } = schema as Record<
    string,
    unknown
  >;
  return Object.keys(rest).length > 0 ? rest as JSONSchema : undefined;
}

function displayCallableInputType(
  callableKind: CallableKind,
  schema: JSONSchema | undefined,
): string {
  if (callableKind === "handler" && schema === undefined) {
    return "void (invoke with no args)";
  }

  if (schema === undefined) {
    return "void";
  }

  const defs =
    typeof schema === "object" && schema !== null && !Array.isArray(schema)
      ? (schema as Record<string, unknown>).$defs as
        | Record<string, JSONSchema>
        | undefined
      : undefined;
  return schemaToTypeString(schema, { defs, maxDepth: 3 });
}
// Lazy-imported in connectSpace() to avoid pulling in heavy CLI deps at import
// time (breaks tests that only use CellBridge for tree/symlink logic).
// import { loadManager } from "../cli/lib/piece.ts";

/**
 * Parse YAML frontmatter from a markdown string.
 * Expects the format: ---\nkey: value\n---\n\nbody...
 */
function parseFrontmatter(
  text: string,
): { frontmatter: Record<string, unknown>; body: string } {
  const fm: Record<string, unknown> = {};
  if (!text.startsWith("---\n")) return { frontmatter: fm, body: text };
  const end = text.indexOf("\n---\n", 4);
  if (end === -1) return { frontmatter: fm, body: text };
  const fmText = text.slice(4, end);
  let body = text.slice(end + 5); // skip "\n---\n"
  if (body.startsWith("\n")) body = body.slice(1); // strip blank separator line
  for (const line of fmText.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    if (!key) continue;
    if (val.length === 0) {
      fm[key] = "";
      continue;
    }
    try {
      const parsed = JSON.parse(val);
      fm[key] = (
          typeof parsed === "string" ||
          typeof parsed === "number" ||
          typeof parsed === "boolean" ||
          parsed === null
        )
        ? parsed
        : val;
    } catch {
      fm[key] = val;
    }
  }
  return { frontmatter: fm, body };
}

type Cancel = () => void;

type ResolveLink = (value: unknown, depth: number) => string | null;

/** Result of resolving an inode to a writable cell path. */
export interface WritePath {
  spaceName: string;
  pieceName: string;
  cell: "input" | "result";
  jsonPath: (string | number)[];
  isJsonFile: boolean;
  piece: PieceController;
  /** Set when the file is an [FS] projection index file. */
  fsProjection?: "markdown" | "json";
}

export interface HandlerTarget {
  piece: PieceController;
  cellProp: "input" | "result";
  cellKey: string;
}

/** Result of resolving an inode to a writable source file path. */
export interface SourceWritePath {
  spaceName: string;
  pieceName: string;
  /** Relative path within .src/, e.g. "main.tsx" or "utils/helper.tsx". */
  relPath: string;
  piece: PieceController;
  /** Inode of the .src/ directory (for error.log lookups). */
  srcIno: bigint;
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
  pieceManifest: Map<string, { pattern: string; summary: string }>;
  /** Per-piece subscription cancellers, keyed by piece name. */
  pieceSubs: Map<string, Cancel[]>;
  did: string;
  unsubscribes: Cancel[];
  /** Used names set for collision resolution. */
  usedNames: Set<string>;
  /** Map from piece name to the inode of its .src/ directory. */
  srcInos: Map<string, bigint>;
  /** Map from piece name to the inode of the synthetic error.log file in .src/. */
  srcErrorLogInos: Map<string, bigint>;
}

interface ScheduledPropRebuild {
  cell: Cell<unknown>;
  latestValue: unknown;
  pieceId: string;
  pieceIno: bigint;
  pieceName: string;
  propName: "input" | "result";
  resolveLink: ResolveLink;
  spaceName: string;
  timer: ReturnType<typeof setTimeout>;
}

interface PropRebuildJob {
  cell: Cell<unknown>;
  newValue: unknown;
  pieceId: string;
  pieceIno: bigint;
  pieceName: string;
  propName: "input" | "result";
  resolveLink: ResolveLink;
  spaceName: string;
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
  /** Coalesced subtree rebuilds keyed by piece inode + prop name. */
  private pendingPropRebuilds = new Map<
    string,
    ScheduledPropRebuild
  >();
  private activePropRebuilds = new Set<string>();
  private deferredPropRebuilds = new Map<string, PropRebuildJob>();
  private debug = false;
  private rebuildStats = {
    scheduled: 0,
    coalesced: 0,
    completed: 0,
    errors: 0,
    maxPending: 0,
    lastDurationMs: 0,
  };
  private execCli: string;
  /**
   * Tracks root-level entries created by [FS] projections so they can be
   * cleared when the result switches back to the default result/ tree.
   */
  private fsProjectionEntries: Map<bigint, Set<string>> = new Map();

  private startedAt = new Date().toISOString();
  /** Inode of the .status file (created by initStatus). */
  private statusIno: bigint | null = null;

  constructor(tree: FsTree, execCli = "") {
    this.tree = tree;
    this.execCli = execCli;
  }

  init(config: {
    apiUrl: string;
    identity: string;
  }): void {
    this.apiUrl = config.apiUrl;
    this.identity = config.identity;
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
    this.updateStatus();
  }

  private debugLog(message: string): void {
    if (this.debug) {
      console.log(message);
    }
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
        debug: this.debug,
        rebuilds: {
          pending: this.pendingPropRebuilds.size +
            this.activePropRebuilds.size +
            this.deferredPropRebuilds.size,
          scheduled: this.rebuildStats.scheduled,
          coalesced: this.rebuildStats.coalesced,
          completed: this.rebuildStats.completed,
          errors: this.rebuildStats.errors,
          maxPending: this.rebuildStats.maxPending,
          lastDurationMs: this.rebuildStats.lastDurationMs,
        },
        startedAt: this.startedAt,
        spaces,
      },
      null,
      2,
    );
  }

  private getManifestPatternFromTree(pieceIno: bigint): string {
    const metaIno = this.tree.lookup(pieceIno, "meta.json");
    if (metaIno === undefined) return "";
    const metaNode = this.tree.getNode(metaIno);
    if (!metaNode || metaNode.kind !== "file") return "";
    try {
      const parsed = JSON.parse(
        new TextDecoder().decode(metaNode.content),
      ) as Record<string, unknown>;
      return typeof parsed.patternName === "string" ? parsed.patternName : "";
    } catch {
      return "";
    }
  }

  private extractSummary(value: unknown): string {
    if (
      typeof value !== "object" || value === null || Array.isArray(value)
    ) {
      return "";
    }
    return typeof (value as Record<string, unknown>).summary === "string"
      ? (value as Record<string, unknown>).summary as string
      : "";
  }

  private getManifestSummaryFromTree(pieceIno: bigint): string {
    const resultIno = this.tree.lookup(pieceIno, "result");
    if (resultIno === undefined) return "";
    const summaryIno = this.tree.lookup(resultIno, "summary");
    if (summaryIno === undefined) return "";
    const summaryNode = this.tree.getNode(summaryIno);
    if (!summaryNode || summaryNode.kind !== "file") return "";
    return new TextDecoder().decode(summaryNode.content);
  }

  private updatePieceManifest(
    state: SpaceState,
    pieceId: string,
    updates: Partial<{ pattern: string; summary: string }>,
  ): boolean {
    const current = state.pieceManifest.get(pieceId) ??
      { pattern: "", summary: "" };
    const next = {
      pattern: updates.pattern ?? current.pattern,
      summary: updates.summary ?? current.summary,
    };
    const changed = next.pattern !== current.pattern ||
      next.summary !== current.summary;
    state.pieceManifest.set(pieceId, next);
    return changed;
  }

  private buildPiecesManifestEntries(state: SpaceState): Array<{
    id: string;
    name: string;
    pattern: string;
    summary: string;
    entityPath: string;
  }> {
    const entries: Array<{
      id: string;
      name: string;
      pattern: string;
      summary: string;
      entityPath: string;
    }> = [];

    for (const [name, id] of state.pieceMap) {
      const manifest = state.pieceManifest.get(id) ??
        { pattern: "", summary: "" };
      entries.push({
        id,
        name,
        pattern: manifest.pattern,
        summary: manifest.summary,
        entityPath: `entities/${id}`,
      });
    }

    return entries;
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
    if (cellSegment === ".handlers") return null;

    // Find the space and piece controller
    const space = this.spaces.get(spaceName);
    if (!space) return null;
    const piece = space.pieceControllers.get(pieceName);
    if (!piece) return null;

    // Handle [FS] projection index files
    if (cellSegment === "index.md") {
      return {
        spaceName,
        pieceName,
        cell: "result",
        jsonPath: [],
        isJsonFile: false,
        piece,
        fsProjection: "markdown",
      };
    }
    if (cellSegment === "index.json") {
      return {
        spaceName,
        pieceName,
        cell: "result",
        jsonPath: [],
        isJsonFile: false,
        piece,
        fsProjection: "json",
      };
    }

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

  /**
   * Resolve an inode to a writable source file path under a .src/ directory.
   *
   * Returns null if the inode is read-only (error.log) or not a .src/ file.
   *
   * Path structure: /<space>/pieces/<piece>/.src/<relPath...>
   */
  resolveSourceWritePath(ino: bigint): SourceWritePath | null {
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

    // segments: [spaceName, "pieces", pieceName, ".src", ...relSegments]
    if (segments.length < 5) return null;
    if (segments[1] !== "pieces") return null;
    if (segments[3] !== ".src") return null;

    const spaceName = segments[0];
    const pieceName = segments[2];
    const relPath = segments.slice(4).join("/");

    const space = this.spaces.get(spaceName);
    if (!space) return null;
    const piece = space.pieceControllers.get(pieceName);
    if (!piece) return null;
    const srcIno = space.srcInos.get(pieceName);
    if (srcIno === undefined) return null;

    // Block writes to the synthetic error.log (identified by inode, not name,
    // so a real source file named error.log remains writable).
    const errorLogIno = space.srcErrorLogInos.get(pieceName);
    if (errorLogIno !== undefined && ino === errorLogIno) return null;

    return { spaceName, pieceName, relPath, piece, srcIno };
  }

  /** Send a value to a handler (stream) cell. */
  async sendToHandler(ino: bigint, value: unknown): Promise<void> {
    const target = this.resolveHandlerTarget(ino);
    if (!target) {
      throw new Error("Not a handler node");
    }
    await this.sendToHandlerTarget(target, value);
  }

  resolveHandlerTarget(ino: bigint): HandlerTarget | null {
    const node = this.tree.getNode(ino);
    if (
      !node || node.kind !== "callable" || node.callableKind !== "handler"
    ) {
      return null;
    }

    const parsed = parseMountedCallablePath(this.tree.getPath(ino));
    if (!parsed || parsed.callableKind !== "handler") {
      return null;
    }

    const space = this.spaces.get(parsed.spaceName);
    if (!space) return null;

    const piece = this.resolvePieceController(space, parsed);
    if (!piece) return null;

    return {
      piece,
      cellProp: node.cellProp,
      cellKey: node.cellKey,
    };
  }

  async sendToHandlerTarget(
    target: HandlerTarget,
    value: unknown,
  ): Promise<void> {
    const rootCell = await target.piece[target.cellProp].getCell();
    const handlerCell = rootCell.key(target.cellKey as keyof unknown) as Cell<
      unknown
    >;
    handlerCell.send(value);
    await target.piece.manager().runtime.idle();
    await target.piece.manager().synced();
  }

  private resolvePieceController(
    space: SpaceState,
    parsed: ReturnType<typeof parseMountedCallablePath>,
  ): PieceController | undefined {
    if (!parsed) return undefined;

    if (parsed.rootKind === "pieces") {
      return space.pieceControllers.get(parsed.rootName);
    }

    const targetEntity = parsed.rootName.startsWith("of:")
      ? parsed.rootName
      : `of:${parsed.rootName}`;
    for (const piece of space.pieceControllers.values()) {
      if (piece.id === parsed.rootName || piece.id === targetEntity) {
        return piece;
      }
    }

    return undefined;
  }

  private propRebuildKey(
    pieceIno: bigint,
    propName: "input" | "result",
  ): string {
    return `${pieceIno}:${propName}`;
  }

  private schedulePropRebuild(args: {
    cell: Cell<unknown>;
    newValue: unknown;
    pieceId: string;
    pieceIno: bigint;
    pieceName: string;
    propName: "input" | "result";
    resolveLink: ResolveLink;
    spaceName: string;
  }): void {
    const key = this.propRebuildKey(args.pieceIno, args.propName);
    const pending = this.pendingPropRebuilds.get(key);
    if (pending) {
      pending.latestValue = args.newValue;
      pending.pieceName = args.pieceName;
      this.rebuildStats.coalesced++;
      this.updateStatus();
      return;
    }

    if (this.activePropRebuilds.has(key)) {
      this.deferredPropRebuilds.set(key, {
        cell: args.cell,
        newValue: args.newValue,
        pieceId: args.pieceId,
        pieceIno: args.pieceIno,
        pieceName: args.pieceName,
        propName: args.propName,
        resolveLink: args.resolveLink,
        spaceName: args.spaceName,
      });
      this.rebuildStats.coalesced++;
      this.rebuildStats.maxPending = Math.max(
        this.rebuildStats.maxPending,
        this.pendingPropRebuilds.size +
          this.activePropRebuilds.size +
          this.deferredPropRebuilds.size,
      );
      this.updateStatus();
      return;
    }

    this.rebuildStats.scheduled++;
    const entry = {
      cell: args.cell,
      latestValue: args.newValue,
      pieceId: args.pieceId,
      pieceIno: args.pieceIno,
      pieceName: args.pieceName,
      propName: args.propName,
      resolveLink: args.resolveLink,
      spaceName: args.spaceName,
      timer: setTimeout(() => {
        this.pendingPropRebuilds.delete(key);
        this.activePropRebuilds.add(key);
        this.updateStatus();
        void this.rebuildPieceProp({
          cell: entry.cell,
          newValue: entry.latestValue,
          pieceId: entry.pieceId,
          pieceIno: entry.pieceIno,
          pieceName: entry.pieceName,
          propName: entry.propName,
          resolveLink: entry.resolveLink,
          spaceName: entry.spaceName,
        }).catch((e) => {
          this.rebuildStats.errors++;
          this.updateStatus();
          console.error(
            `[${entry.spaceName}] Error rebuilding ${entry.pieceName}/${entry.propName}: ${e}`,
          );
        }).finally(() => {
          this.activePropRebuilds.delete(key);
          const deferred = this.deferredPropRebuilds.get(key);
          this.deferredPropRebuilds.delete(key);
          this.updateStatus();
          if (deferred) {
            this.schedulePropRebuild(deferred);
          }
        });
      }, 0),
    };
    this.pendingPropRebuilds.set(key, entry);
    this.rebuildStats.maxPending = Math.max(
      this.rebuildStats.maxPending,
      this.pendingPropRebuilds.size +
        this.activePropRebuilds.size +
        this.deferredPropRebuilds.size,
    );
    this.updateStatus();
  }

  private async rebuildPieceProp(args: {
    cell: Cell<unknown>;
    newValue: unknown;
    pieceId: string;
    pieceIno: bigint;
    pieceName: string;
    propName: "input" | "result";
    resolveLink: ResolveLink;
    spaceName: string;
  }): Promise<void> {
    const startedAt = Date.now();
    if (this.tree.getNode(args.pieceIno)?.kind !== "dir") {
      return;
    }

    const {
      cell,
      newValue,
      pieceId,
      pieceIno,
      pieceName,
      propName,
      resolveLink,
      spaceName,
    } = args;

    const existingIno = this.tree.lookup(pieceIno, propName);
    if (existingIno !== undefined) {
      this.tree.clear(existingIno);
    }
    const jsonIno = this.tree.lookup(pieceIno, `${propName}.json`);
    if (jsonIno !== undefined) {
      this.tree.clear(jsonIno);
    }
    if (propName === "result") {
      this.clearFsProjectionEntries(pieceIno);
    }

    const treeValue = this.materializeTreeValue(cell, newValue);
    let callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    > = [];
    if (treeValue !== undefined && treeValue !== null) {
      const {
        callables: discoveredCallables,
        classifyEntry,
        skipEntry,
      } = this.discoverCallableEntries(cell, treeValue);
      callables = discoveredCallables;

      if (propName === "result") {
        const fsValue = this.readFsValue(cell, treeValue);
        if (fsValue !== null) {
          const indexName = this.buildFsProjectionTree(
            pieceIno,
            pieceId,
            fsValue,
            treeValue,
            callables,
            resolveLink,
            skipEntry,
            classifyEntry,
          );
          this.buildHandlersFile(pieceIno, callables);
          const state = this.spaces.get(spaceName);
          if (state) {
            const summaryChanged = this.updatePieceManifest(state, pieceId, {
              summary: this.extractSummary(treeValue),
            });
            if (summaryChanged) {
              this.updatePiecesJson(state);
              if (this.onInvalidate) {
                this.onInvalidate(state.piecesIno, ["pieces.json"]);
              }
            }
          }
          if (this.onInvalidate) {
            this.onInvalidate(pieceIno, [indexName, ".handlers"]);
          }
          this.rebuildStats.completed++;
          this.rebuildStats.lastDurationMs = Date.now() - startedAt;
          this.updateStatus();
          return;
        }
      }

      const propIno = await buildJsonTreeAsync(
        this.tree,
        pieceIno,
        propName,
        treeValue,
        undefined,
        resolveLink,
        0,
        skipEntry,
        classifyEntry,
      );
      this.addCallableFiles(propIno, callables, propName);
      if (propName === "result") {
        this.addVNodeJsonFiles(propIno, treeValue);
      }
    }
    if (propName === "result") {
      this.buildHandlersFile(pieceIno, callables);
    }

    if (this.onInvalidate) {
      this.onInvalidate(pieceIno, [propName, `${propName}.json`]);
    }

    if (propName === "result") {
      const state = this.spaces.get(spaceName);
      if (state) {
        const summaryChanged = this.updatePieceManifest(state, pieceId, {
          summary: this.extractSummary(treeValue),
        });
        if (summaryChanged) {
          this.updatePiecesJson(state);
          if (this.onInvalidate) {
            this.onInvalidate(state.piecesIno, ["pieces.json"]);
          }
        }
      }
    }

    this.rebuildStats.completed++;
    this.rebuildStats.lastDurationMs = Date.now() - startedAt;
    this.updateStatus();
    this.debugLog(`[${spaceName}] Updated ${pieceName}/${propName}`);
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

  /**
   * Write back an [FS] projection index file (index.md or index.json).
   * Parses the content and writes each field to its corresponding cell path.
   * entityId is always skipped (read-only).
   */
  async writeFsFile(writePath: WritePath, text: string): Promise<boolean> {
    if (writePath.fsProjection === "markdown") {
      const { frontmatter, body } = parseFrontmatter(text);
      let existingFrontmatter: Record<string, unknown> | null = null;
      try {
        const current = await writePath.piece.result.get([
          "$FS",
          "frontmatter",
        ]);
        if (
          typeof current === "object" && current !== null &&
          !Array.isArray(current)
        ) {
          existingFrontmatter = current as Record<string, unknown>;
        }
      } catch {
        // Missing frontmatter is fine.
      }
      for (const [key, val] of Object.entries(frontmatter)) {
        if (key === "entityId") continue;
        await writePath.piece.result.set(val, ["$FS", "frontmatter", key]);
      }
      if (existingFrontmatter) {
        for (const key of Object.keys(existingFrontmatter)) {
          if (key === "entityId" || key in frontmatter) continue;
          await writePath.piece.result.set(undefined, [
            "$FS",
            "frontmatter",
            key,
          ]);
        }
      }
      await writePath.piece.result.set(body, ["$FS", "content"]);
      return true;
    } else if (writePath.fsProjection === "json") {
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(text);
      } catch {
        return false;
      }
      if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
        return false;
      }
      // Plain-object shorthand stores keys directly under $FS instead of
      // nesting them under $FS.content.
      let isPlainObjectShorthand = false;
      let existingContent: Record<string, unknown> | null = null;
      try {
        const fsRaw = await writePath.piece.result.get(["$FS"]);
        isPlainObjectShorthand = typeof fsRaw === "object" && fsRaw !== null &&
          !("type" in (fsRaw as Record<string, unknown>));
        const contentRaw = isPlainObjectShorthand
          ? fsRaw
          : await writePath.piece.result.get(["$FS", "content"]);
        if (
          contentRaw && typeof contentRaw === "object" &&
          !Array.isArray(contentRaw)
        ) {
          existingContent = contentRaw as Record<string, unknown>;
        }
      } catch {
        // If we can't read current state, default to the explicit content form.
      }
      const basePath = isPlainObjectShorthand ? ["$FS"] : ["$FS", "content"];

      const existingKeys = new Set<string>(
        existingContent ? Object.keys(existingContent) : [],
      );
      for (const [key, val] of Object.entries(obj)) {
        if (key === "entityId") continue;
        await writePath.piece.result.set(val, [...basePath, key]);
        existingKeys.delete(key);
      }
      for (const key of existingKeys) {
        if (key === "entityId") continue;
        await writePath.piece.result.set(undefined, [...basePath, key]);
      }
      return true;
    }
    return false;
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
    const { PiecesController } = await import("@commonfabric/piece/ops");
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
      pieceManifest: new Map(),
      pieceSubs: new Map(),
      did: spaceDid,
      unsubscribes: [],
      usedNames: new Set(),
      srcInos: new Map(),
      srcErrorLogInos: new Map(),
    };

    // Fetch all pieces and populate tree
    const allPieces = await pieces.getAllPieces();
    this.debugLog(`[${spaceName}] Found ${allPieces.length} pieces`);

    for (const piece of allPieces) {
      await this.addPieceToSpace(state, piece, spaceName);
    }

    // pieces/.index.json and pieces/pieces.json
    this.updateIndexJson(state);
    this.updatePiecesJson(state);

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
    // Already fully resolved? (has result or input content, not just a stub)
    const existingEntityIno = this.tree.lookup(entitiesIno, entityId);
    if (existingEntityIno !== undefined) {
      const hasContent = this.tree.lookup(existingEntityIno, "result") !==
          undefined ||
        this.tree.lookup(existingEntityIno, "input") !== undefined;
      if (hasContent) return true;
      // Stub dir exists — fall through to populate it in-place
    }

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

    // Build the piece tree under entities/<entityId> and subscribe for updates.
    // Pass existingEntityIno to reuse the stub dir rather than creating a new one.
    const pieceIno = await this.loadPieceTree(
      matchedPiece,
      entitiesIno,
      entityId,
      spaceName,
      existingEntityIno,
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
    await this.buildSourceTree(pieceIno, piece, state, name);
    this.updatePieceManifest(state, piece.id, {
      pattern: this.getManifestPatternFromTree(pieceIno),
      summary: this.getManifestSummaryFromTree(pieceIno),
    });

    const subs = await this.subscribePiece(piece, pieceIno, name, spaceName);
    state.pieceSubs.set(name, subs);

    // Create a lightweight stub entity dir so `ls entities/` shows stable IDs
    // immediately. Full content is populated lazily by resolveEntity() on
    // first access, avoiding doubled subscriptions and startup cost.
    const entityStubIno = this.tree.addDir(state.entitiesIno, piece.id);
    this.tree.addFile(
      entityStubIno,
      "meta.json",
      JSON.stringify(
        { id: piece.id, entityId: piece.id, name: piece.name() || "" },
        null,
        2,
      ),
      "object",
    );

    return name;
  }

  /**
   * Remove a piece from a space's tree and clean up subscriptions.
   */
  private removePieceFromSpace(state: SpaceState, name: string): void {
    const pieceId = state.pieceMap.get(name);
    const pieceIno = this.tree.lookup(state.piecesIno, name);
    if (pieceIno !== undefined) {
      this.fsProjectionEntries.delete(pieceIno);
    }

    // Cancel piece-level subscriptions
    const subs = state.pieceSubs.get(name);
    if (subs) {
      for (const cancel of subs) cancel();
      state.pieceSubs.delete(name);
    }

    // Remove tree nodes
    this.tree.removeChild(state.piecesIno, name);

    // Clean up entity tree
    if (pieceId) {
      const entityIno = this.tree.lookup(state.entitiesIno, pieceId);
      if (entityIno !== undefined) {
        this.fsProjectionEntries.delete(entityIno);
      }
      this.tree.removeChild(state.entitiesIno, pieceId);
      const entitySubsKey = `entity:${pieceId}`;
      const entitySubs = state.pieceSubs.get(entitySubsKey);
      if (entitySubs) {
        for (const cancel of entitySubs) cancel();
        state.pieceSubs.delete(entitySubsKey);
      }
    }

    state.pieceMap.delete(name);
    state.pieceControllers.delete(name);
    if (pieceId) {
      state.pieceManifest.delete(pieceId);
    }
    state.srcInos.delete(name);
    state.srcErrorLogInos.delete(name);
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

    // Capture removed entity IDs before removePieceFromSpace deletes them from pieceMap
    const removedEntityIds = toRemove.map((n) => state.pieceMap.get(n)).filter(
      (id): id is string => id !== undefined,
    );

    for (const name of toRemove) {
      this.removePieceFromSpace(state, name);
      this.debugLog(`[${spaceName}] Removed piece: ${name}`);
    }

    for (const piece of toAdd) {
      const name = await this.addPieceToSpace(state, piece, spaceName);
      this.debugLog(`[${spaceName}] Added piece: ${name}`);
    }

    // Update index and invalidate
    this.updateIndexJson(state);
    this.updatePiecesJson(state);
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
        "pieces.json",
      ];
      this.onInvalidate(state.piecesIno, invalidNames);
      // Also invalidate "pieces" entry on the space dir so readdir refreshes
      this.onInvalidate(state.spaceIno, ["pieces"]);
    }
    // Invalidate added and removed entity dirs
    if (this.onInvalidate) {
      const entityInvalidIds = [
        ...removedEntityIds,
        ...toAdd.map((p) => p.id),
      ];
      if (entityInvalidIds.length > 0) {
        this.onInvalidate(state.entitiesIno, entityInvalidIds);
      }
    }
    // Invalidate cached inode data for pieces dir (forces readdir refresh)
    if (this.onInvalidateInode) {
      this.onInvalidateInode(state.piecesIno);
    }
    this.updateStatus();
  }

  /** Update the pieces/pieces.json manifest for a space. */
  private updatePiecesJson(state: SpaceState): void {
    const entries = this.buildPiecesManifestEntries(state);
    const existingIno = this.tree.lookup(state.piecesIno, "pieces.json");
    if (existingIno !== undefined) {
      this.tree.clear(existingIno);
    }
    this.tree.addFile(
      state.piecesIno,
      "pieces.json",
      JSON.stringify(entries, null, 2),
      "object",
    );
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

  private updatePieceMetaName(parentIno: bigint, name: string): void {
    const metaIno = this.tree.lookup(parentIno, "meta.json");
    if (metaIno === undefined) return;

    const metaNode = this.tree.getNode(metaIno);
    if (!metaNode || metaNode.kind !== "file") return;

    try {
      const parsed = JSON.parse(new TextDecoder().decode(metaNode.content));
      if (
        typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
      ) {
        return;
      }
      this.tree.updateFile(
        metaIno,
        JSON.stringify({ ...parsed, name }, null, 2),
        "object",
      );
    } catch {
      // Ignore malformed synthetic metadata.
    }
  }

  private clearFsProjectionEntries(pieceIno: bigint): void {
    const entries = this.fsProjectionEntries.get(pieceIno);
    this.fsProjectionEntries.delete(pieceIno);

    for (const name of ["index.md", "index.json"]) {
      const ino = this.tree.lookup(pieceIno, name);
      if (ino !== undefined) this.tree.clear(ino);
    }

    if (!entries) return;
    for (const name of entries) {
      const ino = this.tree.lookup(pieceIno, name);
      if (ino !== undefined) this.tree.clear(ino);
    }
  }

  private buildFsProjectionTree(
    pieceIno: bigint,
    pieceId: string,
    fsValue: FsValue,
    treeValue: unknown,
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >,
    resolveLink: (value: unknown, depth: number) => string | null,
    skipEntry: (value: unknown) => boolean,
    classifyEntry: (key: string, value: unknown) => CallableKind | null,
  ): "index.md" | "index.json" {
    const entries = new Set<string>();
    const indexName = fsValue.type === "text/markdown"
      ? "index.md"
      : "index.json";
    entries.add(indexName);

    buildFsProjection(
      this.tree,
      pieceIno,
      fsValue,
      pieceId,
      (siblingParentIno, name, value) => {
        if (siblingParentIno === pieceIno) {
          entries.add(name);
        }
        this.makeFsSubtreeBuilder(
          resolveLink,
          skipEntry,
          classifyEntry,
        )(siblingParentIno, name, value);
      },
    );

    this.addVNodeJsonFiles(pieceIno, treeValue);
    if (
      typeof treeValue === "object" && treeValue !== null &&
      !Array.isArray(treeValue)
    ) {
      for (const [key, value] of Object.entries(treeValue)) {
        if (isVNode(value)) entries.add(`${key}.json`);
      }
    }

    this.addCallableFiles(pieceIno, callables, "result");
    for (const { key, callableKind } of callables) {
      entries.add(`${key}.${callableKind}`);
    }

    this.fsProjectionEntries.set(pieceIno, entries);
    return indexName;
  }

  private discoverCallableEntries(
    rootCell: Cell<unknown>,
    value: unknown,
  ): {
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >;
    skipEntry: (value: unknown) => boolean;
    classifyEntry: (key: string, value: unknown) => CallableKind | null;
  } {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return {
        callables: [],
        skipEntry: () => false,
        classifyEntry: () => null,
      };
    }

    const callableValues = new WeakSet<object>();
    const callableKinds = new Map<string, CallableKind>();
    const callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    > = [];
    for (
      const [key, candidate] of Object.entries(
        value as Record<string, unknown>,
      )
    ) {
      const childCell = rootCell.key(key).asSchemaFromLinks();
      let resolvedCandidate = candidate;
      try {
        resolvedCandidate = childCell.getRaw?.() ?? childCell.get?.() ??
          candidate;
      } catch {
        resolvedCandidate = candidate;
      }

      let callableKind = classifyCallableEntry(candidate, childCell.schema) ??
        classifyCallableEntry(resolvedCandidate, childCell.schema);

      if (!callableKind) {
        try {
          const pattern = childCell.key("pattern").getRaw?.() ??
            childCell.key("pattern").get?.();
          const extraParams = childCell.key("extraParams").get?.();
          if (pattern !== undefined && extraParams !== undefined) {
            callableKind = "tool";
          }
        } catch {
          // Not a pattern tool-shaped child cell.
        }
      }

      if (!callableKind) continue;

      callables.push({
        key,
        callableKind,
        schema: getInputSchema(childCell.schema),
      });
      callableKinds.set(key, callableKind);
      if (typeof candidate === "object" && candidate !== null) {
        callableValues.add(candidate);
      }
    }

    return {
      callables,
      skipEntry: (candidate: unknown) =>
        (typeof candidate === "object" && candidate !== null &&
          callableValues.has(candidate)) ||
        isVNode(candidate),
      classifyEntry: (key: string, candidate: unknown) =>
        typeof candidate === "object" && candidate !== null &&
          callableValues.has(candidate)
          ? callableKinds.get(key) ?? null
          : null,
    };
  }

  private materializeTreeValue(
    rootCell: Cell<unknown>,
    value: unknown,
  ): unknown {
    if (
      value !== undefined && value !== null &&
      (typeof value !== "object" || Array.isArray(value))
    ) {
      return value;
    }

    const schema = rootCell.asSchemaFromLinks().schema as
      | Record<
        string,
        unknown
      >
      | undefined;
    const properties = schema?.properties as
      | Record<string, unknown>
      | undefined;
    if (!properties || Array.isArray(properties)) {
      return value;
    }

    const materialized: Record<string, unknown> =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? { ...(value as Record<string, unknown>) }
        : {};
    for (const key of Object.keys(properties)) {
      const childCell = rootCell.key(key).asSchemaFromLinks();
      let childValue: unknown;
      try {
        childValue = childCell.get?.();
        // Override with raw link reference only for sigil links (enables FUSE symlinks)
        const rawValue = childCell.getRaw?.();
        if (isSigilLink(rawValue)) {
          childValue = rawValue;
        }
      } catch {
        childValue = undefined;
      }

      const callableKind =
        classifyCallableEntry(childValue, childCell.schema) ??
          classifyCallableEntry(childCell, childCell.schema);

      if (callableKind) {
        if (!(key in materialized)) {
          materialized[key] = childValue ?? childCell;
        }
        continue;
      }

      if (childValue !== undefined && !(key in materialized)) {
        materialized[key] = childValue;
      }
    }

    return Object.keys(materialized).length > 0 ? materialized : value;
  }

  private addCallableFiles(
    propIno: bigint,
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >,
    cellProp: "input" | "result",
  ): void {
    for (const { key, callableKind, schema } of callables) {
      const typeStr = displayCallableInputType(callableKind, schema);
      const script = buildCallableScript(this.execCli, schema, typeStr);
      this.tree.addCallable(
        propIno,
        `${key}.${callableKind}`,
        callableKind,
        key,
        cellProp,
        script,
      );
    }
  }

  /**
   * For each VNode-typed property in `value`, add a `<key>.json` file under
   * `parentIno`. This replaces the recursive directory explosion that
   * buildJsonTree would otherwise produce for UI trees.
   * Also removes any previously-projected `<key>.json` files for VNode
   * properties that no longer exist in the current value.
   */
  private addVNodeJsonFiles(parentIno: bigint, value: unknown): void {
    const currentVNodeKeys = new Set<string>();

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (
        const [key, val] of Object.entries(value as Record<string, unknown>)
      ) {
        if (isVNode(val)) {
          currentVNodeKeys.add(key);
          const existing = this.tree.lookup(parentIno, `${key}.json`);
          if (existing !== undefined) this.tree.clear(existing);
          this.tree.addFile(
            parentIno,
            `${key}.json`,
            safeStringify(val),
            "object",
          );
        }
      }
    }

    // Remove stale VNode `.json` files from previous renders.
    // We identify them by looking for `<key>.json` children whose key starts
    // with "$" (VNode keys are always system-prefixed symbols like $UI).
    for (const [name, ino] of this.tree.getChildren(parentIno)) {
      if (
        name.endsWith(".json") && name.startsWith("$") &&
        !currentVNodeKeys.has(name.slice(0, -5))
      ) {
        // Check if this was a VNode file by seeing if the child was a file
        // (not a directory — directories are never VNode projections).
        const node = this.tree.getNode(ino);
        if (node && node.kind === "file") {
          this.tree.clear(ino);
        }
      }
    }
  }

  /**
   * Generate a .handlers summary file at the piece root.
   * One line per callable: "<name>.<handler|tool>  <input-schema-json>"
   * Dot-prefixed so it's hidden from plain `ls` but readable with `cat`.
   */
  private buildHandlersFile(
    pieceIno: bigint,
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >,
  ): void {
    const existingIno = this.tree.lookup(pieceIno, ".handlers");
    if (existingIno !== undefined) this.tree.clear(existingIno);
    if (callables.length === 0) return;
    const lines = callables.map(({ key, callableKind, schema }) => {
      const typeStr = displayCallableInputType(callableKind, schema);
      return `${key}.${callableKind}  ${typeStr}`;
    });
    this.tree.addFile(
      pieceIno,
      ".handlers",
      lines.join("\n") + "\n",
      "string",
    );
  }

  /**
   * Build a subtree callback for `buildFsProjection`.
   * Complex frontmatter fields (arrays of entities, nested objects) are
   * rendered as sibling directories using the standard `buildJsonTree` path.
   */
  private makeFsSubtreeBuilder(
    resolveLink: (v: unknown, depth: number) => string | null,
    skipEntry: (v: unknown) => boolean,
    classifyEntry: (k: string, v: unknown) => CallableKind | null,
  ): (parentIno: bigint, name: string, value: unknown) => void {
    return (parentIno, name, value) => {
      buildJsonTree(
        this.tree,
        parentIno,
        name,
        value,
        undefined,
        resolveLink,
        0,
        skipEntry,
        classifyEntry,
      );
    };
  }

  /**
   * Read [FS] projection values from a result cell.
   * Returns null if the result does not declare [FS].
   */
  private readFsValue(
    resultCell: Cell<unknown>,
    result: unknown,
  ): FsValue | null {
    if (
      typeof result !== "object" || result === null ||
      !("$FS" in (result as Record<string, unknown>))
    ) {
      return null;
    }

    try {
      const fsCell = resultCell.key("$FS");
      const fsRaw = fsCell.get();

      // Plain-object shorthand: no `type` field → treat entire value as JSON content
      if (
        typeof fsRaw === "object" && fsRaw !== null &&
        !("type" in (fsRaw as Record<string, unknown>))
      ) {
        return {
          type: "application/json",
          content: fsRaw as Record<string, unknown>,
        };
      }

      const type = String(fsCell.key("type").get() ?? "text/markdown") as
        | "text/markdown"
        | "application/json";
      const content = fsCell.key("content").get();

      if (type === "text/markdown") {
        const contentStr = String(content ?? "");
        const fmCell = fsCell.key("frontmatter");
        const fmRaw = fmCell.get();
        const frontmatter: Record<string, unknown> = {};
        if (fmRaw && typeof fmRaw === "object" && !Array.isArray(fmRaw)) {
          for (const key of Object.keys(fmRaw as Record<string, unknown>)) {
            frontmatter[key] = fmCell.key(key).get() ?? null;
          }
        }
        return { type, content: contentStr, frontmatter };
      }

      if (type === "application/json") {
        const contentObj = content && typeof content === "object" &&
            !Array.isArray(content)
          ? content as Record<string, unknown>
          : {};
        return { type, content: contentObj };
      }

      return null;
    } catch {
      return null;
    }
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
          // Defer and coalesce the tree rebuild out of the current execution
          // context. cell.sink fires synchronously during cell.set(), which may
          // be called from within a FUSE callback (e.g. flush). Rebuilding the
          // tree and calling notify_inval_entry from inside a FUSE callback
          // crashes FUSE-T and invalidates inodes mid-operation.
          this.schedulePropRebuild({
            cell,
            newValue,
            pieceId: piece.id,
            pieceIno,
            pieceName: piece.name() || pieceName,
            propName,
            resolveLink,
            spaceName,
          });
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

    // Subscribe to the result cell to detect [NAME] changes and rename the
    // piece directory in the FUSE tree accordingly.
    // We use the result cell (not the root entity cell) because [NAME] is part
    // of the pattern's result output, and the scheduler tracks result cell
    // reads when setting up reactive subscriptions.
    try {
      const nameTrackingCell = await piece.result.getCell();
      const cancelRootSub = nameTrackingCell.sink((_newValue: unknown) => {
        setTimeout(() => {
          try {
            const state = this.spaces.get(spaceName);
            if (!state) return;

            // Find the piece's current FUSE name by searching pieceMap.
            let currentName: string | undefined;
            for (const [name, id] of state.pieceMap) {
              if (id === piece.id) {
                currentName = name;
                break;
              }
            }
            if (currentName === undefined) return;

            const newRawName = piece.name() ?? piece.id;

            // Skip if the raw name hasn't changed.
            if (newRawName === currentName) return;

            // Collision-resolve the new name. We need to exclude currentName
            // from the used-name check (the piece is vacating it), but we
            // must NOT mutate usedNames until after tree.rename() succeeds —
            // a thrown rename would otherwise leave tracking inconsistent.
            let newName = newRawName;
            if (state.usedNames.has(newName) && newName !== currentName) {
              let suffix = 2;
              while (
                state.usedNames.has(`${newName}-${suffix}`) &&
                `${newName}-${suffix}` !== currentName
              ) suffix++;
              newName = `${newName}-${suffix}`;
            }

            // Skip if the resolved name is unchanged.
            if (newName === currentName) return;

            // Look up the controller and subs before mutating maps.
            const controller = state.pieceControllers.get(currentName);
            const subs = state.pieceSubs.get(currentName);

            // Rename the directory in the tree — do this before any map
            // mutations so a thrown error leaves state fully consistent.
            this.tree.rename(
              state.piecesIno,
              currentName,
              state.piecesIno,
              newName,
            );

            // Tree rename succeeded — now update all four state maps atomically.
            state.usedNames.delete(currentName);
            state.usedNames.add(newName);
            state.pieceMap.delete(currentName);
            state.pieceMap.set(newName, piece.id);
            state.pieceControllers.delete(currentName);
            if (controller !== undefined) {
              state.pieceControllers.set(newName, controller);
            }
            state.pieceSubs.delete(currentName);
            if (subs !== undefined) {
              state.pieceSubs.set(newName, subs);
            }

            const renamedPieceIno = this.tree.lookup(state.piecesIno, newName);
            if (renamedPieceIno !== undefined) {
              this.updatePieceMetaName(renamedPieceIno, newName);
            }
            const entityIno = this.tree.lookup(state.entitiesIno, piece.id);
            if (entityIno !== undefined) {
              this.updatePieceMetaName(entityIno, newName);
            }

            // Rebuild .index.json and pieces.json.
            this.updateIndexJson(state);
            this.updatePiecesJson(state);

            // Invalidate kernel cache.
            if (this.onInvalidate) {
              this.onInvalidate(state.piecesIno, [
                currentName,
                newName,
                ".index.json",
                "pieces.json",
              ]);
              this.onInvalidate(state.spaceIno, ["pieces"]);
            }
            if (this.onInvalidateInode) {
              this.onInvalidateInode(state.piecesIno);
              if (renamedPieceIno !== undefined) {
                this.onInvalidateInode(renamedPieceIno);
              }
            }

            this.debugLog(
              `[${spaceName}] Renamed piece: ${currentName} → ${newName}`,
            );
          } catch (e) {
            console.error(
              `[${spaceName}] Error renaming piece in FUSE tree: ${e}`,
            );
          }
        }, 0);
      });
      cancels.push(cancelRootSub);
    } catch (e) {
      console.error(
        `[${spaceName}] Could not subscribe to root cell for ${pieceName}: ${e}`,
      );
    }

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
    existingIno?: bigint,
  ): Promise<bigint> {
    const pieceIno = existingIno ?? this.tree.addDir(parentIno, name);

    // Clear existing meta.json if reusing a stub dir (avoids orphaned inode)
    const existingMetaIno = this.tree.lookup(pieceIno, "meta.json");
    if (existingMetaIno !== undefined) this.tree.clear(existingMetaIno);

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

    try {
      // Input data
      const inputCell = await piece.input.getCell();
      const input = this.materializeTreeValue(
        inputCell,
        await piece.input.get(),
      );
      if (input !== undefined && input !== null) {
        const { callables, classifyEntry, skipEntry } = this
          .discoverCallableEntries(
            inputCell,
            input,
          );
        const inputIno = await buildJsonTreeAsync(
          this.tree,
          pieceIno,
          "input",
          input,
          undefined,
          resolveLink,
          0,
          skipEntry,
          classifyEntry,
        );
        this.addCallableFiles(inputIno, callables, "input");
      }

      // Result data
      const resultCell = await piece.result.getCell();
      const result = this.materializeTreeValue(
        resultCell,
        await piece.result.get(),
      );
      if (result !== undefined && result !== null) {
        const { callables, classifyEntry, skipEntry } = this
          .discoverCallableEntries(
            resultCell,
            result,
          );

        const fsValue = this.readFsValue(resultCell, result);
        if (fsValue !== null) {
          // [FS] projection: index.md or index.json at piece root,
          // callable files also at piece root (no result/ dir)
          this.buildFsProjectionTree(
            pieceIno,
            piece.id,
            fsValue,
            result,
            callables,
            resolveLink,
            skipEntry,
            classifyEntry,
          );
        } else {
          // Default: exploded result/ directory
          const resultIno = await buildJsonTreeAsync(
            this.tree,
            pieceIno,
            "result",
            result,
            undefined,
            resolveLink,
            0,
            skipEntry,
            classifyEntry,
          );
          this.addVNodeJsonFiles(resultIno, result);
          this.addCallableFiles(resultIno, callables, "result");
        }
        this.buildHandlersFile(pieceIno, callables);
      }
    } catch (e) {
      console.error(`Error loading piece "${name}": ${e}`);
      this.tree.addFile(pieceIno, "error.txt", String(e), "string");
    }

    return pieceIno;
  }

  /**
   * Build the .src/ subtree for a piece, containing all source files from
   * PatternMeta.program.files[]. Skips system pieces that have no program.
   */
  private async buildSourceTree(
    pieceIno: bigint,
    piece: PieceController,
    state: SpaceState,
    pieceName: string,
  ): Promise<void> {
    let meta: PatternMeta | undefined;
    try {
      meta = await piece.getPatternMeta();
    } catch {
      // Pattern meta not always available
    }

    if (!meta?.program?.files?.length) {
      // System piece or no source — skip .src/
      return;
    }

    // Create or reuse .src/ dir
    let srcIno = this.tree.lookup(pieceIno, ".src");
    if (srcIno !== undefined) {
      this.tree.clear(srcIno);
    }
    srcIno = this.tree.addDir(pieceIno, ".src");
    state.srcInos.set(pieceName, srcIno);

    // Add each source file at its relative path
    const enc = new TextEncoder();
    for (const file of meta.program.files) {
      const relPath = file.name.startsWith("/")
        ? file.name.slice(1)
        : file.name;
      const parts = relPath.split("/");
      let parentIno = srcIno;
      // Create intermediate directories
      for (let i = 0; i < parts.length - 1; i++) {
        const existing = this.tree.lookup(parentIno, parts[i]);
        parentIno = existing ?? this.tree.addDir(parentIno, parts[i]);
      }
      const fileName = parts[parts.length - 1];
      this.tree.addFile(
        parentIno,
        fileName,
        enc.encode(file.contents),
        "string",
      );
    }

    // Add synthetic error.log only if no source file already claimed that name.
    // Track its inode so we can block writes to the synthetic file specifically
    // (a real source file named error.log must remain writable).
    if (this.tree.lookup(srcIno, "error.log") === undefined) {
      const errorLogIno = this.tree.addFile(srcIno, "error.log", "", "string");
      state.srcErrorLogInos.set(pieceName, errorLogIno);
    }
  }
}
