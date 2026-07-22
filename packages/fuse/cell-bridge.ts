// cell-bridge.ts — Bridge PieceManager → FsTree
//
// Populates the filesystem tree with piece data from Common Fabric spaces.
// Supports multiple spaces with on-demand connection.
// Subscribes to cell changes and rebuilds subtrees on updates.

import type { Cell } from "@commonfabric/runner";
import { schemaToTypeString } from "@commonfabric/runner";
import { linkRefPayload } from "@commonfabric/runner/shared";
import { nameSchema } from "@commonfabric/runner/schemas";
import { cfcLabelViewForCell } from "@commonfabric/runner/cfc";
import {
  type CfcLabel,
  type CfcLabelView,
  CfcProjectionAnnotator,
  type CfcProjectionKind,
  deriveCfcProjectionGeneration,
  joinLabels,
} from "./annotations.ts";
import { FsTree, type TransplantChanges } from "./tree.ts";
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
  buildPendingJsonTreeAsync,
  type FsValue,
  isSigilLink,
  isVNode,
  safeStringify,
} from "./tree-builder.ts";
import {
  decodeFuseComponent,
  decodeFusePathSegments,
  encodeFuseComponent,
  encodeFusePathSegments,
} from "./path-codec.ts";
import type { JSONSchema } from "@commonfabric/api";
import type { PieceManager } from "@commonfabric/piece";
import type {
  PieceController,
  PiecePatternRef,
  PiecesController,
} from "@commonfabric/piece/ops";

/** Strip asCell markers from a schema for display as input schema. */
function getInputSchema(
  schema: JSONSchema | undefined,
): JSONSchema | undefined {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return undefined;
  }
  const { asCell: _c, ...rest } = schema as Record<
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

function normalizeProjectedPieceName(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/\p{Extended_Pictographic}|\p{Emoji_Presentation}/gu, " ")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-+/g, "-");

  return normalized || "piece";
}

function resolveProjectedPieceName(
  rawName: string | undefined,
  pieceId: string,
): string {
  const primary = normalizeProjectedPieceName(rawName?.trim() || "");
  if (primary !== "piece") return primary;

  const fallback = normalizeProjectedPieceName(pieceId);
  return fallback || "piece";
}

function encodeSpaceDirectoryName(spaceName: string): string {
  return encodeFuseComponent(spaceName);
}

function decodeSpaceDirectoryName(spaceName: string): string {
  return decodeFuseComponent(spaceName);
}

type Cancel = () => void;

type ResolveLink = (value: unknown, depth: number) => string | null;

export interface CellBridgeOptions {
  cfcAnnotations?: boolean;
  projectionGeneration?: string;
  statusProvider?: () => Record<string, unknown>;
  onCfcProjectionRebuilt?: () => void;
  loadManager?: (config: {
    apiUrl: string;
    space: string;
    identity: string;
    deferSpaceCellSync?: boolean;
  }) => Promise<PieceManager>;
}

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
  pieceInos: Map<string, bigint>; // name → root inode
  pieceControllers: Map<string, PieceController>; // name → controller
  entityControllers: Map<string, PieceController>; // entity ID → controller
  allPieceIds: Set<string>;
  entityIds: Set<string>;
  hasCompleteEntityList: boolean;
  piecesHydrated: boolean;
  piecesMaterializing: boolean;
  pieceListSubscribed: boolean;
  pieceManifest: Map<
    string,
    { summary: string; patternRef?: PiecePatternRef }
  >;
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

interface PieceRootInfo {
  spaceName: string;
  rootKind: "pieces" | "entities";
  rootName: string;
  pieceId: string;
  piece: PieceController;
}

interface PiecePropRootInfo {
  pieceIno: bigint;
  propName: "input" | "result";
}

interface UnhydratedEntityRootInfo {
  state: SpaceState;
  spaceName: string;
  entityId: string;
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
  private connecting = new Map<string, Promise<SpaceState>>();
  /** In-flight piece-list synchronization keyed by space name. */
  private pieceSyncs = new Map<string, Promise<void>>();
  /** Flag: re-run sync after current pass completes. */
  private syncAgain: Set<string> = new Set();
  private pendingPieceHydrations = new Map<string, Promise<void>>();
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
  private pieceRoots = new Map<bigint, PieceRootInfo>();
  private unhydratedEntityRoots = new Map<
    bigint,
    UnhydratedEntityRootInfo
  >();
  private pendingEntityHydrations = new Map<bigint, Promise<boolean>>();
  private piecePropRoots = new Map<bigint, PiecePropRootInfo>();
  private hydratedPieceProps = new Map<bigint, Set<"input" | "result">>();
  /** In-flight hydration promises keyed by `${pieceIno}-${propName}`. */
  private pendingHydrations = new Map<string, Promise<boolean>>();
  private pendingPropRebuildQueues = new Map<string, Promise<void>>();
  /** Monotonic invalidation epoch per hydration key. */
  private hydrationEpochs = new Map<string, number>();
  /**
   * Tracks root-level entries created by [FS] projections so they can be
   * cleared when the result switches back to the default result/ tree.
   */
  private fsProjectionEntries: Map<bigint, Set<string>> = new Map();
  private cfcAnnotationsEnabled = false;
  private explicitCfcProjectionGeneration: string | undefined;
  private statusProvider: (() => Record<string, unknown>) | undefined;
  private onCfcProjectionRebuilt: (() => void) | undefined;
  private managerLoader: CellBridgeOptions["loadManager"];

  private startedAt = new Date().toISOString();
  /**
   * Set to true when a write fails due to a transport/connection error.
   * Once disconnected, all files appear read-only (EACCES on write)
   * so agents get immediate feedback rather than silent data loss.
   * Reconnection is attempted automatically with exponential backoff.
   */
  private _disconnected = false;
  private _disconnectCount = 0;
  private _lastDisconnectReason: string | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  get disconnected(): boolean {
    return this._disconnected;
  }

  /** Mark the bridge as disconnected and schedule reconnection. */
  markDisconnected(reason: string): void {
    if (this._disconnected) return;
    this._disconnected = true;
    this._disconnectCount++;
    this._lastDisconnectReason = reason;
    console.error(
      `[FUSE] Backend connection lost (${reason}) — mount is READ-ONLY. ` +
        `Will attempt reconnection in ${this._reconnectDelayMs()}ms.`,
    );
    this._scheduleReconnect();
  }

  private _reconnectDelayMs(): number {
    // Exponential backoff: 2s, 4s, 8s, 16s, cap at 30s
    return Math.min(2000 * Math.pow(2, this._disconnectCount - 1), 30_000);
  }

  private _scheduleReconnect(): void {
    if (this._reconnectTimer !== null) clearTimeout(this._reconnectTimer);
    const timerId = setTimeout(() => {
      this._reconnectTimer = null;
      this._attemptReconnect();
    }, this._reconnectDelayMs());
    // Don't prevent Deno process from exiting while waiting to reconnect
    Deno.unrefTimer(timerId);
    this._reconnectTimer = timerId;
  }

  private async _attemptReconnect(): Promise<void> {
    for (const [spaceName, state] of this.spaces) {
      try {
        const manager = await this.createSpaceManager(spaceName);
        try {
          await manager.synced();
          if (state.piecesHydrated) {
            await state.pieces.getAllPieces();
          } else {
            await manager.listEntityIds();
          }
          this._disconnected = false;
          this._disconnectCount = 0;
          console.error(
            `[FUSE] Backend connection restored — write access resumed.`,
          );
          return;
        } finally {
          await manager.runtime.dispose().catch((e) => {
            console.warn(
              `[FUSE] Reconnect probe cleanup failed: ${
                e instanceof Error ? e.message : String(e)
              }`,
            );
          });
        }
      } catch (e) {
        console.error(
          `[FUSE] Reconnect probe to ${spaceName} failed: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    // All probes failed — retry with increasing backoff
    this._disconnectCount++;
    console.error(
      `[FUSE] Reconnect failed, retrying in ${this._reconnectDelayMs()}ms`,
    );
    this._scheduleReconnect();
  }

  constructor(tree: FsTree, execCli = "", options: CellBridgeOptions = {}) {
    this.tree = tree;
    this.execCli = execCli;
    this.cfcAnnotationsEnabled = options.cfcAnnotations ?? false;
    this.explicitCfcProjectionGeneration = options.projectionGeneration;
    this.statusProvider = options.statusProvider;
    this.onCfcProjectionRebuilt = options.onCfcProjectionRebuilt;
    this.managerLoader = options.loadManager;
  }

  init(config: {
    apiUrl: string;
    identity: string;
  }): void {
    this.apiUrl = config.apiUrl;
    this.identity = config.identity;
  }

  private async createSpaceManager(spaceName: string): Promise<PieceManager> {
    const loadManager = this.managerLoader ??
      (await import("../cli/lib/piece.ts")).loadManager;
    return await loadManager({
      apiUrl: this.apiUrl,
      space: spaceName,
      identity: this.identity,
      deferSpaceCellSync: true,
    });
  }

  setDebug(debug: boolean): void {
    this.debug = debug;
  }

  private debugLog(message: string): void {
    if (this.debug) {
      console.log(message);
    }
  }

  private cfcSpaceDid(spaceName: string): string {
    return this.spaces.get(spaceName)?.did ?? this.knownSpaces.get(spaceName) ??
      spaceName;
  }

  private spaceNameForState(state: SpaceState): string | undefined {
    for (const [name, candidate] of this.spaces) {
      if (candidate === state) return name;
    }
    for (const [name, did] of this.knownSpaces) {
      if (did === state.did) return name;
    }
    return undefined;
  }

  private cfcLabelViewForCell(cell: Cell<unknown>): CfcLabelView | undefined {
    if (!this.cfcAnnotationsEnabled) return undefined;
    try {
      return cfcLabelViewForCell(cell) as CfcLabelView | undefined;
    } catch {
      return undefined;
    }
  }

  private makeCfcAnnotator(options: {
    spaceName: string;
    spaceDid?: string;
    pieceId?: string;
    rootKind?: "pieces" | "entities";
    cell?: "input" | "result";
    labelView?: CfcLabelView;
    value?: unknown;
  }): CfcProjectionAnnotator | undefined {
    if (!this.cfcAnnotationsEnabled) return undefined;
    const space = options.spaceDid ?? this.cfcSpaceDid(options.spaceName);
    const generation = this.explicitCfcProjectionGeneration ??
      deriveCfcProjectionGeneration({
        space,
        entity: options.pieceId,
        rootKind: options.rootKind,
        cell: options.cell,
        value: options.value,
        labelView: options.labelView,
      });
    return new CfcProjectionAnnotator(this.tree, {
      space,
      entity: options.pieceId,
      rootKind: options.rootKind,
      cell: options.cell,
      generation,
      labelView: options.labelView,
    });
  }

  private annotateSyntheticNode(
    annotator: CfcProjectionAnnotator | undefined,
    ino: bigint,
    projection: CfcProjectionKind,
    path: readonly (string | number)[],
    parent?: { ino: bigint; name: string },
    contentLabel?: CfcLabel,
  ): void {
    if (!annotator) return;
    annotator.annotateSynthetic(ino, { projection, path, contentLabel });
    if (parent) {
      annotator.annotateEntry(parent.ino, parent.name, ino, {
        labelPath: path,
      });
    }
  }

  /**
   * Create the .status file at the mount root. Call once after init.
   *
   * The file is generated: `getStatusJson` runs when a reader asks the tree for
   * the file's size, and no caller has to announce that a counter moved.
   */
  initStatus(): void {
    this.tree.addGeneratedFile(
      this.tree.rootIno,
      ".status",
      () => this.getStatusJson(),
      "object",
    );
  }

  /** Generate current status as JSON. */
  private getStatusJson(): string {
    const spaces: Record<
      string,
      { did: string; pieces: number; piecesLoaded: boolean }
    > = {};
    for (const [name, state] of this.spaces) {
      spaces[name] = {
        did: state.did,
        pieces: state.pieceMap.size,
        piecesLoaded: state.piecesHydrated,
      };
    }
    const extra = this.statusProvider?.() ?? {};
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
        connection: {
          disconnected: this._disconnected,
          disconnectCount: this._disconnectCount,
          lastDisconnectReason: this._lastDisconnectReason,
        },
        ...extra,
      },
      null,
      2,
    );
  }

  private noteCfcProjectionRebuilt(): void {
    try {
      this.onCfcProjectionRebuilt?.();
    } catch (e) {
      console.warn(`[fuse] CFC writeback reconciliation error: ${e}`);
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

  private async refreshPieceManifest(
    state: SpaceState,
    piece: PieceController,
  ): Promise<void> {
    let summary = "";
    let patternRef: PiecePatternRef | undefined;

    try {
      const result = await piece.result.get();
      summary = this.extractSummary(result);
    } catch {
      // Summary is best-effort only.
    }

    try {
      patternRef = await piece.getPatternRef();
    } catch {
      // Pattern source is best-effort; identity-less pieces remain listable.
    }

    this.updatePieceManifest(state, piece.id, { summary, patternRef });
  }

  /** Refresh synthetic pattern metadata after an in-place pattern swap. */
  private async refreshPiecePatternMetadata(
    state: SpaceState,
    piece: PieceController,
    pieceIno: bigint,
  ): Promise<void> {
    let patternRef: PiecePatternRef | undefined;
    try {
      patternRef = await piece.getPatternRef();
    } catch {
      return;
    }
    if (patternRef === undefined) return;

    const manifestChanged = this.updatePieceManifest(state, piece.id, {
      patternRef,
    });
    this.updatePieceMetaPatternRef(pieceIno, patternRef);

    const entityIno = this.tree.lookup(
      state.entitiesIno,
      encodeFuseComponent(piece.id),
    );
    if (entityIno !== undefined) {
      this.updatePieceMetaPatternRef(entityIno, patternRef);
    }

    if (manifestChanged) {
      this.updatePiecesJson(state);
    }
    if (this.onInvalidate) {
      this.onInvalidate(pieceIno, ["meta.json"]);
      if (entityIno !== undefined) {
        this.onInvalidate(entityIno, ["meta.json"]);
      }
      if (manifestChanged) {
        this.onInvalidate(state.piecesIno, ["pieces.json"]);
      }
    }
  }

  private updatePieceManifest(
    state: SpaceState,
    pieceId: string,
    updates: Partial<{ summary: string; patternRef: PiecePatternRef }>,
  ): boolean {
    const current = state.pieceManifest.get(pieceId) ?? { summary: "" };
    const next = {
      summary: updates.summary ?? current.summary,
      patternRef: updates.patternRef ?? current.patternRef,
    };
    const changed = next.summary !== current.summary ||
      next.patternRef?.identity !== current.patternRef?.identity ||
      next.patternRef?.symbol !== current.patternRef?.symbol ||
      next.patternRef?.source.ref !== current.patternRef?.source.ref ||
      next.patternRef?.source.repository !==
        current.patternRef?.source.repository ||
      next.patternRef?.source.entry !== current.patternRef?.source.entry ||
      next.patternRef?.source.origin !== current.patternRef?.source.origin;
    state.pieceManifest.set(pieceId, next);
    return changed;
  }

  private buildPiecesManifestEntries(state: SpaceState): Array<{
    id: string;
    name: string;
    summary: string;
    entityPath: string;
    patternRef?: PiecePatternRef;
  }> {
    const entries: Array<{
      id: string;
      name: string;
      summary: string;
      entityPath: string;
      patternRef?: PiecePatternRef;
    }> = [];

    for (const [name, id] of state.pieceMap) {
      const manifest = state.pieceManifest.get(id) ?? { summary: "" };
      entries.push({
        id,
        name,
        summary: manifest.summary,
        entityPath: `entities/${encodeFuseComponent(id)}`,
        ...(manifest.patternRef === undefined
          ? {}
          : { patternRef: manifest.patternRef }),
      });
    }

    return entries;
  }

  /** Connect to a space and populate its tree. */
  async connectSpace(spaceName: string): Promise<SpaceState> {
    const existing = this.spaces.get(spaceName);
    if (existing) return existing;

    const existingConnection = this.connecting.get(spaceName);
    if (existingConnection) return await existingConnection;

    const connection = this.connectSpaceOnce(spaceName).finally(() => {
      if (this.connecting.get(spaceName) === connection) {
        this.connecting.delete(spaceName);
      }
    });
    this.connecting.set(spaceName, connection);
    return await connection;
  }

  private async connectSpaceOnce(spaceName: string): Promise<SpaceState> {
    let manager: PieceManager | undefined;
    let state: SpaceState | undefined;
    try {
      manager = await this.createSpaceManager(spaceName);
      const listedIds = await manager.listEntityIds();
      state = await this.buildSpaceTree(spaceName, manager);

      this.applyEntityList(state, spaceName, listedIds, state.allPieceIds);
      this.updateIndexJson(state);
      this.updatePiecesJson(state);
      this.spaces.set(spaceName, state);
      this.knownSpaces.set(spaceName, state.did);
      this.updateSpacesJson();
      return state;
    } catch (error) {
      if (state) {
        this.removeFailedSpaceTree(spaceName, state);
      } else {
        this.tree.removeChild(
          this.tree.rootIno,
          encodeSpaceDirectoryName(spaceName),
        );
      }
      this.spaces.delete(spaceName);
      this.knownSpaces.delete(spaceName);
      if (manager) {
        await manager.runtime.dispose().catch((disposeError) => {
          console.warn(
            `[FUSE] Failed space cleanup for ${spaceName}: ${
              disposeError instanceof Error
                ? disposeError.message
                : String(disposeError)
            }`,
          );
        });
      }
      throw error;
    }
  }

  private removeFailedSpaceTree(spaceName: string, state: SpaceState): void {
    for (const cancel of state.unsubscribes) cancel();
    for (const subscriptions of state.pieceSubs.values()) {
      for (const cancel of subscriptions) cancel();
    }
    for (const [, ino] of this.tree.getChildren(state.piecesIno)) {
      this.unregisterPieceRoot(ino);
    }
    for (const [, ino] of this.tree.getChildren(state.entitiesIno)) {
      this.unhydratedEntityRoots.delete(ino);
      this.pendingEntityHydrations.delete(ino);
      this.unregisterPieceRoot(ino);
    }
    this.pendingPieceHydrations.delete(spaceName);
    this.pieceSyncs.delete(spaceName);
    this.syncAgain.delete(spaceName);
    this.tree.removeChild(
      this.tree.rootIno,
      encodeSpaceDirectoryName(spaceName),
    );
  }

  isConnecting(spaceName: string): boolean {
    return this.connecting.has(spaceName);
  }

  private registerPieceRoot(
    pieceIno: bigint,
    info: PieceRootInfo,
  ): void {
    this.pieceRoots.set(pieceIno, info);
    if (!this.hydratedPieceProps.has(pieceIno)) {
      this.hydratedPieceProps.set(pieceIno, new Set());
    }
  }

  private ensurePiecePropStub(
    pieceIno: bigint,
    propName: "input" | "result",
    annotator?: CfcProjectionAnnotator,
  ): bigint | undefined {
    if (this.tree.getNode(pieceIno)?.kind !== "dir") return undefined;
    let propIno = this.tree.lookup(pieceIno, propName);
    if (propIno === undefined) {
      propIno = this.tree.addDir(pieceIno, propName);
    }
    annotator?.annotateJsonDirectory(propIno, [], {});
    annotator?.annotateEntry(pieceIno, propName, propIno);
    this.piecePropRoots.set(propIno, { pieceIno, propName });
    // Also ensure a stub JSON file so lookups for result.json / input.json
    // can reply immediately from tree while hydration runs in the background.
    const jsonName = `${propName}.json`;
    if (this.tree.lookup(pieceIno, jsonName) === undefined) {
      const jsonIno = this.tree.addFile(pieceIno, jsonName, "{}", "object");
      annotator?.annotateJsonAggregate(jsonIno, [], {});
      annotator?.annotateEntry(pieceIno, jsonName, jsonIno);
    }
    return propIno;
  }

  private unregisterPieceRoot(pieceIno: bigint): void {
    for (const propName of ["input", "result"] as const) {
      const propIno = this.tree.lookup(pieceIno, propName);
      if (propIno !== undefined) this.piecePropRoots.delete(propIno);
      const key = `${pieceIno}-${propName}`;
      this.pendingHydrations.delete(key);
      this.hydrationEpochs.delete(key);
    }
    this.hydratedPieceProps.delete(pieceIno);
    this.pieceRoots.delete(pieceIno);
  }

  private markPiecePropHydrated(
    pieceIno: bigint,
    propName: "input" | "result",
  ): void {
    let hydrated = this.hydratedPieceProps.get(pieceIno);
    if (!hydrated) {
      hydrated = new Set();
      this.hydratedPieceProps.set(pieceIno, hydrated);
    }
    hydrated.add(propName);

    const propIno = this.tree.lookup(pieceIno, propName);
    if (propIno !== undefined) {
      this.piecePropRoots.set(propIno, { pieceIno, propName });
    }
  }

  private markPiecePropCleared(
    pieceIno: bigint,
    propName: "input" | "result",
  ): void {
    const propIno = this.tree.lookup(pieceIno, propName);
    if (propIno !== undefined) {
      this.piecePropRoots.delete(propIno);
    }
    this.hydratedPieceProps.get(pieceIno)?.delete(propName);
  }

  private getPieceInfo(
    pieceIno: bigint,
  ): (PieceRootInfo & { state?: SpaceState }) | null {
    const info = this.pieceRoots.get(pieceIno);
    if (!info) return null;
    return { ...info, state: this.spaces.get(info.spaceName) };
  }

  shouldPrepareLookup(parentIno: bigint, name: string): boolean {
    if (this.stateForPiecesDir(parentIno)) return true;
    if (name.startsWith(".") && name !== ".handlers") return false;
    if (this.isEntitiesDir(parentIno)) return true;
    if (this.unhydratedEntityRoots.has(parentIno)) return true;
    if (this.pieceRoots.has(parentIno)) return true;
    if (this.piecePropRoots.has(parentIno)) return true;
    return false;
  }

  shouldPrepareDirectory(ino: bigint): boolean {
    return this.stateForPiecesDir(ino) !== undefined ||
      this.isEntitiesDir(ino) || this.unhydratedEntityRoots.has(ino) ||
      this.pieceRoots.has(ino) || this.piecePropRoots.has(ino);
  }

  shouldSynchronizeLookup(parentIno: bigint): boolean {
    return this.stateForPiecesDir(parentIno) !== undefined ||
      this.piecePropRoots.has(parentIno);
  }

  async prepareLookup(parentIno: bigint, name: string): Promise<boolean> {
    const pieces = this.stateForPiecesDir(parentIno);
    if (pieces) {
      await this.materializePieces(pieces.state, pieces.spaceName);
      return this.tree.lookup(parentIno, name) !== undefined;
    }

    if (this.isEntitiesDir(parentIno)) {
      return await this.resolveEntity(parentIno, name);
    }

    if (this.unhydratedEntityRoots.has(parentIno)) {
      if (!await this.hydrateEntityRoot(parentIno)) return false;
    }

    const pieceInfo = this.getPieceInfo(parentIno);
    if (pieceInfo) {
      if (name === "input" || name === "input.json") {
        await this.hydratePieceProp(parentIno, "input");
        return true;
      }
      if (
        name === "result" || name === "result.json" ||
        name === "index.md" || name === "index.json" || name === ".handlers"
      ) {
        await this.hydratePieceProp(parentIno, "result");
        return true;
      }
      return false;
    }

    const propInfo = this.piecePropRoots.get(parentIno);
    if (propInfo) {
      await this.hydratePieceProp(propInfo.pieceIno, propInfo.propName);
      return true;
    }

    return false;
  }

  async prepareDirectory(ino: bigint): Promise<boolean> {
    const pieces = this.stateForPiecesDir(ino);
    if (pieces) {
      await this.materializePieces(pieces.state, pieces.spaceName);
      return true;
    }

    const entities = this.stateForEntitiesDir(ino);
    if (entities) {
      await this.syncEntityListOnce(
        entities.state,
        entities.spaceName,
        entities.state.allPieceIds,
      );
      return true;
    }

    if (this.unhydratedEntityRoots.has(ino)) {
      if (!await this.hydrateEntityRoot(ino)) return false;
    }

    const pieceInfo = this.getPieceInfo(ino);
    if (pieceInfo) {
      await this.hydratePieceProp(ino, "input");
      await this.hydratePieceProp(ino, "result");
      return true;
    }

    const propInfo = this.piecePropRoots.get(ino);
    if (propInfo) {
      await this.hydratePieceProp(propInfo.pieceIno, propInfo.propName);
      return true;
    }

    return false;
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

    const spaceName = decodeSpaceDirectoryName(segments[0]);
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
        const decoded = decodeFuseComponent(s);
        const n = Number(decoded);
        return Number.isInteger(n) && n >= 0 && String(n) === decoded
          ? n
          : decoded;
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

    const spaceName = decodeSpaceDirectoryName(segments[0]);
    const pieceName = segments[2];
    const relPath = decodeFusePathSegments(segments.slice(4)).join("/");

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
    const entityController = space.entityControllers.get(parsed.rootName) ??
      space.entityControllers.get(targetEntity);
    if (entityController) return entityController;

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
        void this.enqueuePiecePropRebuild({
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
          console.error(
            `[${entry.spaceName}] Error rebuilding ${entry.pieceName}/${entry.propName}: ${e}`,
          );
        }).finally(() => {
          this.activePropRebuilds.delete(key);
          const deferred = this.deferredPropRebuilds.get(key);
          this.deferredPropRebuilds.delete(key);
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
  }

  /**
   * Swap a freshly built staging node into its live position.
   *
   * When the live node and the staging node share a kind, their subtrees are
   * reconciled in place so the live inode survives (see
   * {@link FsTree.transplantSubtree}); the inodes whose content changed are
   * appended to `changedInodes` so the caller can drop their kernel data
   * cache. When the kinds differ, or when there is no live node, the staging
   * node takes the live name with its freshly allocated inode. When the
   * replacement produced no staging node, the live node is removed.
   *
   * This runs synchronously, so no filesystem request observes a half-swapped
   * tree.
   */
  private swapPending(
    parentIno: bigint,
    liveName: string,
    pendingName: string,
    oldIno: bigint | undefined,
    changes: TransplantChanges,
    annotator?: CfcProjectionAnnotator,
  ): void {
    const pendingIno = this.tree.lookup(parentIno, pendingName);
    if (pendingIno === undefined) {
      if (oldIno !== undefined) {
        this.tree.clear(oldIno);
        this.recordEntryChange(changes, parentIno, liveName);
      }
      return;
    }
    const pendingNode = this.tree.getNode(pendingIno);
    const oldNode = oldIno !== undefined
      ? this.tree.getNode(oldIno)
      : undefined;
    if (oldNode && pendingNode && oldNode.kind === pendingNode.kind) {
      // Same path, same kind: the live inode survives, so its entry under the
      // parent is unchanged and is left cached.
      this.mergeTransplantChanges(
        changes,
        this.tree.transplantSubtree(oldIno!, pendingIno),
      );
      annotator?.annotateEntry(parentIno, liveName, oldIno!);
    } else {
      if (oldIno !== undefined) {
        this.tree.clear(oldIno);
      }
      this.tree.rename(parentIno, pendingName, parentIno, liveName);
      const movedIno = this.tree.lookup(parentIno, liveName);
      if (movedIno !== undefined) {
        annotator?.annotateEntry(parentIno, liveName, movedIno);
      }
      this.recordEntryChange(changes, parentIno, liveName);
    }
  }

  private recordEntryChange(
    changes: TransplantChanges,
    parentIno: bigint,
    name: string,
  ): void {
    let names = changes.entryChanges.get(parentIno);
    if (!names) {
      names = new Set();
      changes.entryChanges.set(parentIno, names);
    }
    names.add(name);
  }

  private mergeTransplantChanges(
    into: TransplantChanges,
    from: TransplantChanges,
  ): void {
    for (const ino of from.changedInodes) {
      into.changedInodes.add(ino);
    }
    for (const [parentIno, names] of from.entryChanges) {
      for (const name of names) {
        this.recordEntryChange(into, parentIno, name);
      }
    }
  }

  /**
   * Drop exactly the kernel caches a rebuild made stale: the changed inodes'
   * data, and the changed directory entries. Entries and inodes the rebuild
   * left untouched stay cached, so a client that walked into the piece does
   * not have its cached dentries invalidated by an unrelated rebuild.
   */
  private emitInvalidations(changes: TransplantChanges): void {
    if (this.onInvalidateInode) {
      for (const ino of changes.changedInodes) {
        this.onInvalidateInode(ino);
      }
    }
    if (this.onInvalidate) {
      for (const [parentIno, names] of changes.entryChanges) {
        this.onInvalidate(parentIno, [...names]);
      }
    }
  }

  /**
   * Advance the piece directory's mtime if its top-level entry set changed
   * since `namesBefore`. Compares names, not inodes, so a rebuilt `.handlers`
   * (same name, new inode) does not count while a prop appearing or an
   * `index.md` replacing the result tree does.
   */
  private touchPieceDirIfEntriesChanged(
    pieceIno: bigint,
    namesBefore: Set<string>,
  ): void {
    const namesAfter = this.tree.getChildren(pieceIno).map(([name]) => name);
    if (
      namesAfter.length !== namesBefore.size ||
      namesAfter.some((name) => !namesBefore.has(name))
    ) {
      this.tree.touch(pieceIno);
    }
  }

  /**
   * Advance the hydration epoch for a prop so an in-flight hydration that read
   * a now-superseded value re-reads and rebuilds. Used when a cell change
   * arrives: the mounted tree is rebuilt in place rather than torn down, so
   * this is all the reactive path needs to stay consistent.
   */
  private bumpHydrationEpoch(
    rootIno: bigint,
    propName: "input" | "result",
  ): void {
    const key = `${rootIno}-${propName}`;
    this.hydrationEpochs.set(key, (this.hydrationEpochs.get(key) ?? 0) + 1);
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
    const jsonIno = this.tree.lookup(pieceIno, `${propName}.json`);
    const pendingPropName = `.${propName}.pending`;
    const pendingJsonName = `${pendingPropName}.json`;
    const rootInfo = this.pieceRoots.get(pieceIno);
    const labelView = this.cfcLabelViewForCell(cell);
    const pendingIno = this.tree.lookup(pieceIno, pendingPropName);
    if (pendingIno !== undefined) {
      this.tree.clear(pendingIno);
    }
    const pendingJsonIno = this.tree.lookup(pieceIno, pendingJsonName);
    if (pendingJsonIno !== undefined) {
      this.tree.clear(pendingJsonIno);
    }

    const treeValue = this.materializeTreeValue(cell, newValue);
    const cfcAnnotator = this.makeCfcAnnotator({
      spaceName,
      pieceId,
      rootKind: rootInfo?.rootKind ?? "pieces",
      cell: propName,
      value: treeValue,
      labelView,
    });
    let callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    > = [];
    // The kernel caches that this rebuild made stale: inodes whose content
    // changed and, per directory, the child names whose entry changed. Only
    // these are invalidated, so a client keeps every cache entry the rebuild
    // left untouched.
    const changes: TransplantChanges = {
      changedInodes: new Set(),
      entryChanges: new Map(),
    };
    // The piece directory's top-level entries (input, result, index.md,
    // .handlers, …) can appear or disappear across this rebuild — a prop
    // hydrating, or a result switching between the normal tree and an [FS]
    // projection. Its mtime is advanced only if that name set changes; a
    // content-only rebuild leaves it untouched. Staging containers are transient
    // within a rebuild, so they are absent from both the before and after names.
    const pieceNamesBefore = new Set(
      this.tree.getChildren(pieceIno).map(([name]) => name),
    );
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
          this.markPiecePropCleared(pieceIno, propName);

          // The projection entries currently at the piece root; a rebuild
          // adopts the ones that survive with the same kind and removes the
          // rest.
          const oldFsNames = new Set<string>(
            this.fsProjectionEntries.get(pieceIno) ?? [],
          );
          oldFsNames.add("index.md");
          oldFsNames.add("index.json");

          // Switching from a normal result/ tree to an [FS] projection replaces
          // the result directory and its .json sibling.
          if (existingIno !== undefined) {
            this.tree.clear(existingIno);
            this.recordEntryChange(changes, pieceIno, propName);
          }
          if (jsonIno !== undefined) {
            this.tree.clear(jsonIno);
            this.recordEntryChange(changes, pieceIno, `${propName}.json`);
          }

          // Build the projection under a staging container, then reconcile it
          // onto the piece directory so a surviving entry keeps its inode.
          const staleStage = this.tree.lookup(pieceIno, ".fs.pending");
          if (staleStage !== undefined) {
            this.tree.clear(staleStage);
          }
          const stageIno = this.tree.addDir(pieceIno, ".fs.pending");
          this.buildFsProjectionTree(
            stageIno,
            pieceId,
            fsValue,
            treeValue,
            callables,
            resolveLink,
            skipEntry,
            classifyEntry,
            cfcAnnotator,
          );
          const newFsNames = this.swapFsProjection(
            pieceIno,
            stageIno,
            oldFsNames,
            changes,
            cfcAnnotator,
          );
          this.fsProjectionEntries.set(pieceIno, newFsNames);

          this.buildHandlersFile(pieceIno, callables, cfcAnnotator);
          this.recordEntryChange(changes, pieceIno, ".handlers");

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
          this.touchPieceDirIfEntriesChanged(pieceIno, pieceNamesBefore);
          this.emitInvalidations(changes);
          this.markPiecePropHydrated(pieceIno, "result");
          this.rebuildStats.completed++;
          this.rebuildStats.lastDurationMs = Date.now() - startedAt;
          this.noteCfcProjectionRebuilt();
          return;
        }
      }

      const buildRootName = existingIno !== undefined || jsonIno !== undefined
        ? pendingPropName
        : propName;
      const propIno = buildRootName === pendingPropName
        ? await buildPendingJsonTreeAsync(
          this.tree,
          pieceIno,
          propName,
          treeValue,
          undefined,
          resolveLink,
          0,
          skipEntry,
          classifyEntry,
          cfcAnnotator?.jsonContext([]),
        )
        : await buildJsonTreeAsync(
          this.tree,
          pieceIno,
          propName,
          treeValue,
          undefined,
          resolveLink,
          0,
          skipEntry,
          classifyEntry,
          cfcAnnotator?.jsonContext([]),
        );
      this.addCallableFiles(propIno, callables, propName, cfcAnnotator);
      if (propName === "result") {
        this.addVNodeJsonFiles(propIno, treeValue, cfcAnnotator);
      }
      if (buildRootName === pendingPropName) {
        this.markPiecePropCleared(pieceIno, propName);
        if (propName === "result") {
          this.clearFsProjectionEntries(pieceIno, changes);
        }
        // Reconcile the freshly built staging subtree onto the existing one,
        // reusing the existing inodes rather than swapping in fresh ones, so a
        // path that still exists keeps its inode across the rebuild.
        this.swapPending(
          pieceIno,
          propName,
          pendingPropName,
          existingIno,
          changes,
          cfcAnnotator,
        );
        this.swapPending(
          pieceIno,
          `${propName}.json`,
          pendingJsonName,
          jsonIno,
          changes,
          cfcAnnotator,
        );
      } else {
        if (propName === "result") {
          this.clearFsProjectionEntries(pieceIno, changes);
        }
        // First hydration: the prop directory and its `.json` sibling are new
        // to any cache, so their entries under the piece are invalidated.
        this.recordEntryChange(changes, pieceIno, propName);
        if (this.tree.lookup(pieceIno, `${propName}.json`) !== undefined) {
          this.recordEntryChange(changes, pieceIno, `${propName}.json`);
        }
      }
      this.markPiecePropHydrated(pieceIno, propName);
    } else {
      this.markPiecePropCleared(pieceIno, propName);
      if (existingIno !== undefined) {
        this.tree.clear(existingIno);
        this.recordEntryChange(changes, pieceIno, propName);
      }
      if (jsonIno !== undefined) {
        this.tree.clear(jsonIno);
        this.recordEntryChange(changes, pieceIno, `${propName}.json`);
      }
      if (propName === "result") {
        this.clearFsProjectionEntries(pieceIno, changes);
      }
    }
    if (propName === "result") {
      // `.handlers` is rebuilt on the piece directory, outside the prop
      // subtree the transplant reconciled, so its entry is invalidated here.
      this.buildHandlersFile(pieceIno, callables, cfcAnnotator);
      this.recordEntryChange(changes, pieceIno, ".handlers");
    }

    this.touchPieceDirIfEntriesChanged(pieceIno, pieceNamesBefore);
    this.emitInvalidations(changes);

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
    this.noteCfcProjectionRebuilt();
    this.debugLog(`[${spaceName}] Updated ${pieceName}/${propName}`);
  }

  private async enqueuePiecePropRebuild(args: PropRebuildJob): Promise<void> {
    const key = this.propRebuildKey(args.pieceIno, args.propName);
    const previous = this.pendingPropRebuildQueues.get(key) ??
      Promise.resolve();
    const current = previous.catch(() => {}).then(() =>
      this.rebuildPieceProp(args)
    );
    this.pendingPropRebuildQueues.set(key, current);
    try {
      await current;
    } finally {
      if (this.pendingPropRebuildQueues.get(key) === current) {
        this.pendingPropRebuildQueues.delete(key);
      }
    }
  }

  private static readonly MAX_HYDRATION_RETRIES = 3;

  private hydratePieceProp(
    pieceIno: bigint,
    propName: "input" | "result",
    retries = 0,
  ): Promise<boolean> {
    const info = this.getPieceInfo(pieceIno);
    if (!info) return Promise.resolve(false);
    if (this.hydratedPieceProps.get(pieceIno)?.has(propName)) {
      return Promise.resolve(true);
    }

    const key = `${pieceIno}-${propName}`;
    const existing = this.pendingHydrations.get(key);
    if (existing) return existing;
    const startedEpoch = this.hydrationEpochs.get(key) ?? 0;

    const cleanup = () => {
      if (this.pendingHydrations.get(key) === handle.promise) {
        this.pendingHydrations.delete(key);
      }
    };
    const handle: { promise: Promise<boolean> } = {
      promise: (async (): Promise<boolean> => {
        try {
          const cell = await info.piece[propName].getCell();
          const newValue = await info.piece[propName].get();
          await this.enqueuePiecePropRebuild({
            cell,
            newValue,
            pieceId: info.piece.id,
            pieceIno,
            pieceName: info.rootName,
            propName,
            resolveLink: this.makeLinkResolver(info.spaceName),
            spaceName: info.spaceName,
          });
          const currentEpoch = this.hydrationEpochs.get(key) ?? 0;
          const stillHydrated =
            this.hydratedPieceProps.get(pieceIno)?.has(propName) ?? false;
          if (currentEpoch !== startedEpoch || !stillHydrated) {
            cleanup();
            if (retries >= CellBridge.MAX_HYDRATION_RETRIES) {
              return false;
            }
            return await this.hydratePieceProp(
              pieceIno,
              propName,
              retries + 1,
            );
          }
          return true;
        } finally {
          cleanup();
        }
      })(),
    };

    this.pendingHydrations.set(key, handle.promise);
    return handle.promise;
  }

  /** Collect all inode IDs in a subtree (including the root). */
  private collectDescendantInos(ino: bigint): bigint[] {
    const result: bigint[] = [ino];
    const node = this.tree.getNode(ino);
    if (node?.kind === "dir") {
      for (const [, childIno] of this.tree.getChildren(ino)) {
        result.push(...this.collectDescendantInos(childIno));
      }
    }
    return result;
  }

  private invalidateRootPropCache(
    rootIno: bigint,
    propName: "input" | "result",
  ): boolean {
    if (this.tree.getNode(rootIno)?.kind !== "dir") return false;

    const invalidatedNames = new Set<string>([propName, `${propName}.json`]);
    const key = `${rootIno}-${propName}`;
    this.hydrationEpochs.set(key, (this.hydrationEpochs.get(key) ?? 0) + 1);
    this.markPiecePropCleared(rootIno, propName);

    // Collect all descendant inodes BEFORE clearing (tree.clear removes
    // them), so the invalidation below can name every inode whose cached
    // data is about to go stale, not just the entries under this prop.
    const staleInos: bigint[] = [];
    const propIno = this.tree.lookup(rootIno, propName);
    if (propIno !== undefined) {
      staleInos.push(...this.collectDescendantInos(propIno));
      this.tree.clear(propIno);
    }
    const jsonIno = this.tree.lookup(rootIno, `${propName}.json`);
    if (jsonIno !== undefined) {
      staleInos.push(jsonIno);
      this.tree.clear(jsonIno);
    }
    this.ensurePiecePropStub(rootIno, propName);

    if (propName === "result") {
      const fsEntries = this.fsProjectionEntries.get(rootIno);
      if (fsEntries) {
        for (const name of fsEntries) {
          invalidatedNames.add(name);
          const fsIno = this.tree.lookup(rootIno, name);
          if (fsIno !== undefined) {
            staleInos.push(...this.collectDescendantInos(fsIno));
          }
        }
      }
      this.clearFsProjectionEntries(rootIno);

      const handlersIno = this.tree.lookup(rootIno, ".handlers");
      if (handlersIno !== undefined) {
        staleInos.push(handlersIno);
        this.tree.clear(handlersIno);
      }
      invalidatedNames.add(".handlers");
    }

    if (this.onInvalidate) {
      this.onInvalidate(rootIno, [...invalidatedNames]);
    }
    if (this.onInvalidateInode) {
      this.onInvalidateInode(rootIno);
      for (const staleIno of staleInos) {
        this.onInvalidateInode(staleIno);
      }
    }
    return true;
  }

  private invalidatePieceIdPropCache(
    pieceId: string,
    propName: "input" | "result",
  ): void {
    for (const state of this.spaces.values()) {
      for (const [name, id] of state.pieceMap) {
        if (id !== pieceId) continue;
        const pieceIno = state.pieceInos.get(name);
        if (pieceIno !== undefined) {
          this.invalidateRootPropCache(pieceIno, propName);
        }
      }

      const entityIno = this.tree.lookup(
        state.entitiesIno,
        encodeFuseComponent(pieceId),
      );
      if (entityIno !== undefined) {
        this.invalidateRootPropCache(entityIno, propName);
      }
    }
  }

  invalidateWritePath(writePath: WritePath): void {
    this.invalidatePieceIdPropCache(writePath.piece.id, writePath.cell);
  }

  async finalizeWritePath(writePath: WritePath): Promise<void> {
    const state = this.spaces.get(writePath.spaceName);
    const pieceIno = state?.pieceInos.get(writePath.pieceName);
    if (pieceIno === undefined) {
      this.invalidateWritePath(writePath);
      return;
    }
    const cell = await writePath.piece[writePath.cell].getCell();
    const newValue = await writePath.piece[writePath.cell].get();
    await this.enqueuePiecePropRebuild({
      cell,
      newValue,
      pieceId: writePath.piece.id,
      pieceIno,
      pieceName: writePath.pieceName,
      propName: writePath.cell,
      resolveLink: this.makeLinkResolver(writePath.spaceName),
      spaceName: writePath.spaceName,
    });
  }

  async finalizeSourceWritePath(writePath: SourceWritePath): Promise<void> {
    const state = this.spaces.get(writePath.spaceName);
    const pieceIno = state?.pieceInos.get(writePath.pieceName);
    if (!state || pieceIno === undefined) return;
    await this.buildSourceTree(
      pieceIno,
      writePath.piece,
      state,
      writePath.pieceName,
    );
    await this.refreshPiecePatternMetadata(
      state,
      writePath.piece,
      pieceIno,
    );
  }

  invalidateHandlerTarget(target: HandlerTarget): void {
    this.invalidatePieceIdPropCache(target.piece.id, target.cellProp);
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
      ? decodeSpaceDirectoryName(parentSegments[0])
      : undefined;

    // Match: /<space>/entities/<hash>[/<path...>]
    if (resolved.length >= 3 && resolved[1] === "entities") {
      const targetSpace = resolved[0];
      const decodedTargetSpace = decodeFuseComponent(targetSpace);
      const hash = decodeFuseComponent(resolved[2]);
      const pathParts = decodeFusePathSegments(resolved.slice(3));

      const result: { id?: string; path?: string[]; space?: string } = {
        id: hash,
      };

      if (pathParts.length > 0) {
        result.path = pathParts;
      }

      // Omit space if same as current
      if (decodedTargetSpace !== currentSpace) {
        const did = this.knownSpaces.get(decodedTargetSpace);
        result.space = did || decodedTargetSpace;
      }

      return result;
    }

    // Self-reference: target within same piece, no entities/ segment
    // Resolved path: [space, "pieces", pieceName, cell, ...subpath]
    if (resolved.length >= 4 && resolved[1] === "pieces") {
      const subpath = decodeFusePathSegments(resolved.slice(4));
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
    const spacesIno = this.tree.addFile(
      this.tree.rootIno,
      ".spaces.json",
      JSON.stringify(obj, null, 2),
      "object",
    );
    const annotator = this.makeCfcAnnotator({
      spaceName: "common-fabric:mount",
      spaceDid: "common-fabric:mount",
      value: obj,
    });
    this.annotateSyntheticNode(
      annotator,
      spacesIno,
      "space-meta",
      [".spaces.json"],
    );
  }

  private async buildSpaceTree(
    spaceName: string,
    manager: PieceManager,
  ): Promise<SpaceState> {
    const { PiecesController } = await import("@commonfabric/piece/ops");
    const pieces = new PiecesController(manager);

    // Create space directory structure
    const spaceIno = this.tree.addDir(
      this.tree.rootIno,
      encodeSpaceDirectoryName(spaceName),
    );
    const piecesIno = this.tree.addDir(spaceIno, "pieces");
    const entitiesIno = this.tree.addDir(spaceIno, "entities");

    // space.json: DID + name
    const spaceDid = manager.getSpace();
    const spaceMeta = { did: spaceDid, name: spaceName };
    const spaceAnnotator = this.makeCfcAnnotator({
      spaceName,
      spaceDid,
      value: spaceMeta,
    });
    const piecesAnnotator = this.makeCfcAnnotator({
      spaceName,
      spaceDid,
      rootKind: "pieces",
      value: { rootKind: "pieces" },
    });
    const entitiesAnnotator = this.makeCfcAnnotator({
      spaceName,
      spaceDid,
      rootKind: "entities",
      value: { rootKind: "entities" },
    });
    spaceAnnotator?.annotateJsonDirectory(spaceIno, [], {});
    piecesAnnotator?.annotateJsonDirectory(piecesIno, [], {});
    entitiesAnnotator?.annotateJsonDirectory(entitiesIno, [], {});
    spaceAnnotator?.annotateEntry(spaceIno, "pieces", piecesIno);
    spaceAnnotator?.annotateEntry(spaceIno, "entities", entitiesIno);

    const spaceJsonIno = this.tree.addFile(
      spaceIno,
      "space.json",
      JSON.stringify(spaceMeta, null, 2),
      "object",
    );
    this.annotateSyntheticNode(
      spaceAnnotator,
      spaceJsonIno,
      "space-meta",
      ["space.json"],
      { ino: spaceIno, name: "space.json" },
    );

    const state: SpaceState = {
      manager,
      pieces,
      spaceIno,
      piecesIno,
      entitiesIno,
      pieceMap: new Map(),
      pieceInos: new Map(),
      pieceControllers: new Map(),
      entityControllers: new Map(),
      allPieceIds: new Set(),
      entityIds: new Set(),
      hasCompleteEntityList: false,
      piecesHydrated: false,
      piecesMaterializing: false,
      pieceListSubscribed: false,
      pieceManifest: new Map(),
      pieceSubs: new Map(),
      did: spaceDid,
      unsubscribes: [],
      usedNames: new Set(),
      srcInos: new Map(),
      srcErrorLogInos: new Map(),
    };

    return state;
  }

  private stateForEntitiesDir(
    ino: bigint,
  ): { state: SpaceState; spaceName: string } | undefined {
    for (const [spaceName, state] of this.spaces) {
      if (state.entitiesIno === ino) return { state, spaceName };
    }
    return undefined;
  }

  private stateForPiecesDir(
    ino: bigint,
  ): { state: SpaceState; spaceName: string } | undefined {
    for (const [spaceName, state] of this.spaces) {
      if (state.piecesIno === ino) return { state, spaceName };
    }
    return undefined;
  }

  private materializePieces(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    const existing = this.pendingPieceHydrations.get(spaceName);
    if (existing) return existing;
    if (state.piecesHydrated) return Promise.resolve();

    const pending = (async () => {
      state.piecesMaterializing = true;
      try {
        await this.subscribePieceList(state, spaceName);
        await this.syncPieceList(state, spaceName);
        state.piecesHydrated = true;
      } finally {
        state.piecesMaterializing = false;
      }
    })().finally(() => {
      if (this.pendingPieceHydrations.get(spaceName) === pending) {
        this.pendingPieceHydrations.delete(spaceName);
      }
    });
    this.pendingPieceHydrations.set(spaceName, pending);
    return pending;
  }

  private async subscribePieceList(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    if (state.pieceListSubscribed) return;

    const piecesCell = await state.manager.getPieces();
    const piecesListCancel = piecesCell.sink(() => {
      setTimeout(() => {
        this.syncPieceList(state, spaceName).catch((e) => {
          console.error(`[${spaceName}] Piece list sync error: ${e}`);
        });
      }, 0);
    });
    state.unsubscribes.push(piecesListCancel);
    state.pieceListSubscribed = true;
  }

  private ensureEntityStub(
    state: SpaceState,
    spaceName: string,
    entityId: string,
  ): bigint {
    const entityName = encodeFuseComponent(entityId);
    const existingIno = this.tree.lookup(state.entitiesIno, entityName);
    if (existingIno !== undefined) {
      if (!this.pieceRoots.has(existingIno)) {
        this.unhydratedEntityRoots.set(existingIno, {
          state,
          spaceName,
          entityId,
        });
      }
      return existingIno;
    }

    const entityIno = this.tree.addDir(state.entitiesIno, entityName);
    const annotator = this.makeCfcAnnotator({
      spaceName,
      spaceDid: state.did,
      pieceId: entityId,
      rootKind: "entities",
      value: { entityId },
    });
    annotator?.annotateJsonDirectory(entityIno, [], {});
    annotator?.annotateEntry(state.entitiesIno, entityName, entityIno);
    this.unhydratedEntityRoots.set(entityIno, {
      state,
      spaceName,
      entityId,
    });
    return entityIno;
  }

  private async syncEntityListOnce(
    state: SpaceState,
    spaceName: string,
    requiredIds: Iterable<string>,
  ): Promise<boolean> {
    const listedIds = await state.manager.listEntityIds();
    return this.applyEntityList(state, spaceName, listedIds, requiredIds);
  }

  private applyEntityList(
    state: SpaceState,
    spaceName: string,
    listedIds: string[] | undefined,
    requiredIds: Iterable<string>,
  ): boolean {
    const hasCompleteEntityList = listedIds !== undefined;
    const liveIds = new Set([...(listedIds ?? []), ...requiredIds].sort());
    const invalidatedNames: string[] = [];

    for (const entityId of liveIds) {
      const entityName = encodeFuseComponent(entityId);
      if (this.tree.lookup(state.entitiesIno, entityName) === undefined) {
        this.ensureEntityStub(state, spaceName, entityId);
        invalidatedNames.push(entityName);
      }
    }

    for (const entityId of state.entityIds) {
      if (liveIds.has(entityId)) continue;
      const entityName = encodeFuseComponent(entityId);
      const entityIno = this.tree.lookup(state.entitiesIno, entityName);
      if (entityIno !== undefined) {
        this.unhydratedEntityRoots.delete(entityIno);
        this.unregisterPieceRoot(entityIno);
        this.fsProjectionEntries.delete(entityIno);
        this.tree.removeChild(state.entitiesIno, entityName);
        invalidatedNames.push(entityName);
      }
      state.entityControllers.delete(entityId);
    }

    state.entityIds = liveIds;
    state.hasCompleteEntityList = hasCompleteEntityList;
    if (invalidatedNames.length > 0) {
      this.tree.touch(state.entitiesIno);
      this.onInvalidate?.(state.entitiesIno, invalidatedNames);
      this.onInvalidateInode?.(state.entitiesIno);
    }
    return hasCompleteEntityList;
  }

  private hydrateEntityRoot(entityIno: bigint): Promise<boolean> {
    if (this.pieceRoots.has(entityIno)) return Promise.resolve(true);
    const existing = this.pendingEntityHydrations.get(entityIno);
    if (existing) return existing;
    const info = this.unhydratedEntityRoots.get(entityIno);
    if (!info) return Promise.resolve(false);

    const pending = (async () => {
      const piece = info.state.entityControllers.get(info.entityId) ??
        await info.state.pieces.get(info.entityId, false);
      if (this.unhydratedEntityRoots.get(entityIno) !== info) return false;
      info.state.entityControllers.set(info.entityId, piece);
      await this.loadPieceTree(
        piece,
        info.state.entitiesIno,
        encodeFuseComponent(info.entityId),
        info.spaceName,
        entityIno,
        "entities",
      );
      this.unhydratedEntityRoots.delete(entityIno);
      return true;
    })().finally(() => {
      if (this.pendingEntityHydrations.get(entityIno) === pending) {
        this.pendingEntityHydrations.delete(entityIno);
      }
    });
    this.pendingEntityHydrations.set(entityIno, pending);
    return pending;
  }

  /**
   * Resolve an entity ID under a space's entities/ directory on demand.
   * Existing identifier stubs resolve without loading their entity values.
   * Missing entries refresh the complete identifier list. Servers without
   * identifier listing use the known piece controllers.
   * Returns true if resolved successfully.
   */
  async resolveEntity(
    entitiesIno: bigint,
    entityId: string,
  ): Promise<boolean> {
    const decodedEntityId = decodeFuseComponent(entityId);
    if (encodeFuseComponent(decodedEntityId) !== entityId) {
      return false;
    }

    if (this.tree.lookup(entitiesIno, entityId) !== undefined) {
      return true;
    }

    const entities = this.stateForEntitiesDir(entitiesIno);
    if (!entities) return false;
    const hasCompleteEntityList = await this.syncEntityListOnce(
      entities.state,
      entities.spaceName,
      entities.state.allPieceIds,
    );
    if (this.tree.lookup(entitiesIno, entityId) !== undefined) return true;
    if (hasCompleteEntityList) return false;

    const piece = [...entities.state.pieceControllers.values()].find(
      (candidate) => candidate.id === decodedEntityId,
    );
    if (!piece || encodeFuseComponent(piece.id) !== entityId) return false;
    const entityIno = this.ensureEntityStub(
      entities.state,
      entities.spaceName,
      piece.id,
    );
    this.unhydratedEntityRoots.delete(entityIno);
    entities.state.entityIds.add(piece.id);
    entities.state.entityControllers.set(piece.id, piece);
    await this.loadPieceTree(
      piece,
      entitiesIno,
      entityId,
      entities.spaceName,
      entityIno,
      "entities",
    );
    return true;
  }

  /** Check whether an inode is any space's entities/ directory. */
  isEntitiesDir(ino: bigint): boolean {
    return this.stateForEntitiesDir(ino) !== undefined;
  }

  /**
   * Best-effort load of a piece's NAME doc through the same schema path that
   * `piece.name()` reads synchronously. The piece list deliberately doesn't
   * load linked piece docs (its items are `asCell`), so on a cold runtime
   * `piece.name()` races the doc load and would fall back to the opaque
   * id-derived directory name — permanently, if no later change event fires.
   */
  private async syncPieceName(piece: PieceController): Promise<void> {
    if (typeof piece.getCell !== "function") return;
    try {
      await (piece.getCell() as Cell<unknown>).asSchema(nameSchema).sync();
    } catch {
      // Name stays unavailable; addPieceToSpace falls back to the piece id.
    }
  }

  /**
   * Add a single piece to a space's tree.
   * Returns the assigned display name.
   */
  private async addPieceToSpace(
    state: SpaceState,
    piece: PieceController,
    spaceName: string,
  ): Promise<string> {
    // The piece list deliberately doesn't load the linked piece docs
    // (pieceListSchema items are `asCell`), so on a cold runtime the
    // synchronous `piece.name()` read races the doc load and the directory
    // would be created under the opaque id-derived fallback name — and never
    // renamed if no further change event arrives. Await the NAME through the
    // same schema path `name()` reads before choosing the directory name.
    await this.syncPieceName(piece);
    const rawName = piece.name();
    let name = resolveProjectedPieceName(rawName, piece.id);
    this.debugLog(
      `[${spaceName}] addPieceToSpace: id=${piece.id} rawName=${
        JSON.stringify(rawName)
      } resolved=${name}`,
    );
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
      undefined,
      "pieces",
    );
    state.pieceInos.set(name, pieceIno);
    await this.buildSourceTree(pieceIno, piece, state, name);
    await this.refreshPieceManifest(state, piece);

    const subs = await this.subscribePiece(
      piece,
      pieceIno,
      name,
      spaceName,
      state,
    );
    state.pieceSubs.set(name, subs);

    // Keep the entity path stable while input and result values remain lazy.
    const entityName = encodeFuseComponent(piece.id);
    const entityStubIno = this.ensureEntityStub(state, spaceName, piece.id);
    this.unhydratedEntityRoots.delete(entityStubIno);
    state.entityIds.add(piece.id);
    state.entityControllers.set(piece.id, piece);
    await this.loadPieceTree(
      piece,
      state.entitiesIno,
      entityName,
      spaceName,
      entityStubIno,
      "entities",
    );

    // The pieces and entities directories gained an entry.
    this.tree.touch(state.piecesIno);
    this.tree.touch(state.entitiesIno);

    return name;
  }

  /**
   * Remove a piece from a space's tree and clean up subscriptions.
   */
  private removePieceFromSpace(state: SpaceState, name: string): void {
    const pieceId = state.pieceMap.get(name);
    const pieceIno = this.tree.lookup(state.piecesIno, name);
    if (pieceIno !== undefined) {
      this.unregisterPieceRoot(pieceIno);
      this.fsProjectionEntries.delete(pieceIno);
    }

    // Cancel piece-level subscriptions
    const subs = state.pieceSubs.get(name);
    if (subs) {
      for (const cancel of subs) cancel();
      state.pieceSubs.delete(name);
    }

    // Remove tree nodes
    if (this.tree.removeChild(state.piecesIno, name) !== undefined) {
      this.tree.touch(state.piecesIno);
    }

    // Clean up the entity tree when the entity itself is no longer live.
    if (
      pieceId &&
      (!state.hasCompleteEntityList || !state.entityIds.has(pieceId))
    ) {
      const entityName = encodeFuseComponent(pieceId);
      const entityIno = this.tree.lookup(state.entitiesIno, entityName);
      if (entityIno !== undefined) {
        this.unhydratedEntityRoots.delete(entityIno);
        this.unregisterPieceRoot(entityIno);
        this.fsProjectionEntries.delete(entityIno);
      }
      if (this.tree.removeChild(state.entitiesIno, entityName) !== undefined) {
        this.tree.touch(state.entitiesIno);
      }
      state.entityIds.delete(pieceId);
      state.entityControllers.delete(pieceId);
    }

    state.pieceMap.delete(name);
    state.pieceInos.delete(name);
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
  private syncPieceList(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    const existing = this.pieceSyncs.get(spaceName);
    if (existing) {
      this.syncAgain.add(spaceName);
      return existing;
    }

    const pending = this.runPieceListSync(state, spaceName).finally(() => {
      if (this.pieceSyncs.get(spaceName) === pending) {
        this.pieceSyncs.delete(spaceName);
      }
    });
    this.pieceSyncs.set(spaceName, pending);
    return pending;
  }

  private async runPieceListSync(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    do {
      this.syncAgain.delete(spaceName);
      await this.syncPieceListOnce(state, spaceName);
    } while (this.syncAgain.has(spaceName));
  }

  /** Single pass of piece list sync (called by guarded syncPieceList). */
  private async syncPieceListOnce(
    state: SpaceState,
    spaceName: string,
  ): Promise<void> {
    const allPieces = await state.pieces.getAllPieces();
    state.allPieceIds = new Set(allPieces.map((piece) => piece.id));
    this.debugLog(
      `[${spaceName}] syncPieceListOnce: live=${allPieces.length} tracked=${state.pieceMap.size}`,
    );
    await this.syncEntityListOnce(
      state,
      spaceName,
      state.allPieceIds,
    );

    if (!state.piecesHydrated && !state.piecesMaterializing) return;

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
      ].map((id) => encodeFuseComponent(id));
      if (entityInvalidIds.length > 0) {
        this.onInvalidate(state.entitiesIno, entityInvalidIds);
      }
    }
    // Invalidate cached inode data for pieces dir (forces readdir refresh)
    if (this.onInvalidateInode) {
      this.onInvalidateInode(state.piecesIno);
    }
  }

  /** Update the pieces/pieces.json manifest for a space. */
  private updatePiecesJson(state: SpaceState): void {
    const entries = this.buildPiecesManifestEntries(state);
    const existingIno = this.tree.lookup(state.piecesIno, "pieces.json");
    if (existingIno !== undefined) {
      this.tree.clear(existingIno);
    }
    const piecesJsonIno = this.tree.addFile(
      state.piecesIno,
      "pieces.json",
      JSON.stringify(entries, null, 2),
      "object",
    );
    const annotator = this.makeCfcAnnotator({
      spaceName: this.spaceNameForState(state) ?? state.did,
      spaceDid: state.did,
      rootKind: "pieces",
      value: entries,
    });
    this.annotateSyntheticNode(
      annotator,
      piecesJsonIno,
      "pieces-manifest",
      ["pieces.json"],
      { ino: state.piecesIno, name: "pieces.json" },
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
    const indexIno = this.tree.addFile(
      state.piecesIno,
      ".index.json",
      JSON.stringify(indexObj, null, 2),
      "object",
    );
    const annotator = this.makeCfcAnnotator({
      spaceName: this.spaceNameForState(state) ?? state.did,
      spaceDid: state.did,
      rootKind: "pieces",
      value: indexObj,
    });
    this.annotateSyntheticNode(
      annotator,
      indexIno,
      "pieces-manifest",
      [".index.json"],
      { ino: state.piecesIno, name: ".index.json" },
    );
  }

  private updatePieceMetaName(parentIno: bigint, name: string): void {
    this.updatePieceMeta(parentIno, { name });
  }

  private updatePieceMetaPatternRef(
    parentIno: bigint,
    patternRef: PiecePatternRef,
  ): void {
    this.updatePieceMeta(parentIno, { patternRef });
  }

  private updatePieceMeta(
    parentIno: bigint,
    updates: Record<string, unknown>,
  ): void {
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
        JSON.stringify({ ...parsed, ...updates }, null, 2),
        "object",
      );
    } catch {
      // Ignore malformed synthetic metadata.
    }
  }

  /**
   * Remove a piece's [FS] projection entries from the tree. When `changes` is
   * supplied, each removed entry is recorded so its cached directory entry is
   * invalidated — a projection leaving the piece root (the result becomes null
   * or switches back to the normal result tree) must drop the client's cached
   * `index.md` and sibling dentries, or they resolve to freed inodes. The
   * `.fs.pending` staging container is internal and never has a cached entry,
   * so it is cleared but not recorded.
   */
  private clearFsProjectionEntries(
    pieceIno: bigint,
    changes?: TransplantChanges,
  ): void {
    const entries = this.fsProjectionEntries.get(pieceIno);
    this.fsProjectionEntries.delete(pieceIno);

    for (const name of ["index.md", "index.json", ".fs.pending"]) {
      const ino = this.tree.lookup(pieceIno, name);
      if (ino !== undefined) {
        this.tree.clear(ino);
        if (changes && name !== ".fs.pending") {
          this.recordEntryChange(changes, pieceIno, name);
        }
      }
    }

    if (!entries) return;
    for (const name of entries) {
      const ino = this.tree.lookup(pieceIno, name);
      if (ino !== undefined) {
        this.tree.clear(ino);
        if (changes) this.recordEntryChange(changes, pieceIno, name);
      }
    }
  }

  /**
   * Build a piece's [FS] projection under `parentIno`, which is a staging
   * container so the finished projection can be reconciled onto the piece
   * directory without churning inodes. Returns the index file name and the set
   * of entry names produced, so the caller can swap them into place and record
   * which piece-root names the projection now owns.
   */
  private buildFsProjectionTree(
    parentIno: bigint,
    pieceId: string,
    fsValue: FsValue,
    treeValue: unknown,
    callables: Array<
      { key: string; callableKind: CallableKind; schema?: JSONSchema }
    >,
    resolveLink: (value: unknown, depth: number) => string | null,
    skipEntry: (value: unknown) => boolean,
    classifyEntry: (key: string, value: unknown) => CallableKind | null,
    annotator?: CfcProjectionAnnotator,
  ): { indexName: "index.md" | "index.json"; entries: Set<string> } {
    const entries = new Set<string>();
    const indexName = fsValue.type === "text/markdown"
      ? "index.md"
      : "index.json";
    entries.add(indexName);

    const indexIno = buildFsProjection(
      this.tree,
      parentIno,
      fsValue,
      pieceId,
      (siblingParentIno, name, value) => {
        if (siblingParentIno === parentIno) {
          entries.add(encodeFuseComponent(name, { reserveJsonSuffix: true }));
        }
        this.makeFsSubtreeBuilder(
          resolveLink,
          skipEntry,
          classifyEntry,
          annotator,
        )(siblingParentIno, name, value);
      },
    );
    const projectionLabel = annotator?.subtreeLabel(treeValue, []);
    this.annotateSyntheticNode(
      annotator,
      indexIno,
      "fs-projection",
      [indexName],
      { ino: parentIno, name: indexName },
      projectionLabel,
    );

    this.addVNodeJsonFiles(parentIno, treeValue, annotator);
    if (
      typeof treeValue === "object" && treeValue !== null &&
      !Array.isArray(treeValue)
    ) {
      for (const [key, value] of Object.entries(treeValue)) {
        if (isVNode(value)) entries.add(`${encodeFuseComponent(key)}.json`);
      }
    }

    this.addCallableFiles(parentIno, callables, "result", annotator);
    for (const { key, callableKind } of callables) {
      entries.add(`${encodeFuseComponent(key)}.${callableKind}`);
    }

    return { indexName, entries };
  }

  /**
   * Reconcile a staging container's children onto the piece directory, adopting
   * an existing inode whenever a name survives with the same node kind so [FS]
   * projection entries keep their inode across a rebuild. Old projection entries
   * absent from the rebuild are removed. Returns the entry names now present.
   */
  private swapFsProjection(
    pieceIno: bigint,
    stageIno: bigint,
    oldNames: Iterable<string>,
    changes: TransplantChanges,
    annotator?: CfcProjectionAnnotator,
  ): Set<string> {
    const newNames = new Set<string>();
    for (const [name, stagedIno] of this.tree.getChildren(stageIno)) {
      newNames.add(name);
      const oldIno = this.tree.lookup(pieceIno, name);
      const oldNode = oldIno !== undefined
        ? this.tree.getNode(oldIno)
        : undefined;
      const stagedNode = this.tree.getNode(stagedIno);
      if (oldNode && stagedNode && oldNode.kind === stagedNode.kind) {
        this.mergeTransplantChanges(
          changes,
          this.tree.transplantSubtree(oldIno!, stagedIno),
        );
        annotator?.annotateEntry(pieceIno, name, oldIno!);
      } else {
        if (oldIno !== undefined) {
          this.tree.clear(oldIno);
        }
        this.tree.rename(stageIno, name, pieceIno, name);
        const movedIno = this.tree.lookup(pieceIno, name);
        if (movedIno !== undefined) {
          annotator?.annotateEntry(pieceIno, name, movedIno);
        }
        this.recordEntryChange(changes, pieceIno, name);
      }
    }
    for (const name of oldNames) {
      if (newNames.has(name)) continue;
      const oldIno = this.tree.lookup(pieceIno, name);
      if (oldIno !== undefined) {
        this.tree.clear(oldIno);
        this.recordEntryChange(changes, pieceIno, name);
      }
    }
    this.tree.clear(stageIno);
    return newNames;
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
    const schema = rootCell.asSchemaFromLinks().schema as
      | Record<string, unknown>
      | undefined;
    const schemaProperties = schema?.properties as
      | Record<string, unknown>
      | undefined;
    const valueObject = typeof value === "object" && value !== null &&
        !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
    const candidateKeys = new Set<string>([
      ...Object.keys(valueObject ?? {}),
      ...Object.keys(
        schemaProperties &&
          typeof schemaProperties === "object" &&
          !Array.isArray(schemaProperties)
          ? schemaProperties
          : {},
      ),
    ]);
    if (candidateKeys.size === 0) {
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
    for (const key of candidateKeys) {
      const candidate = valueObject?.[key];
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
      classifyEntry: (key: string) => callableKinds.get(key) ?? null,
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
    annotator?: CfcProjectionAnnotator,
  ): void {
    for (const { key, callableKind, schema } of callables) {
      const typeStr = displayCallableInputType(callableKind, schema);
      const script = buildCallableScript(this.execCli, schema, typeStr);
      const fileName = `${encodeFuseComponent(key)}.${callableKind}`;
      const callableIno = this.tree.addCallable(
        propIno,
        fileName,
        callableKind,
        key,
        cellProp,
        script,
      );
      const schemaLabel = schema === undefined
        ? undefined
        : annotator?.subtreeLabel(schema, [key]);
      annotator?.annotateCallable(callableIno, [key], {
        callableKind,
        cellKey: key,
        cellProp,
        schemaLabel,
      });
      annotator?.annotateEntry(propIno, fileName, callableIno, {
        labelPath: [key],
      });
    }
  }

  /**
   * For each VNode-typed property in `value`, add a `<key>.json` file under
   * `parentIno`. This replaces the recursive directory explosion that
   * buildJsonTree would otherwise produce for UI trees.
   * Also removes any previously-projected `<key>.json` files for VNode
   * properties that no longer exist in the current value.
   */
  private addVNodeJsonFiles(
    parentIno: bigint,
    value: unknown,
    annotator?: CfcProjectionAnnotator,
  ): void {
    const currentVNodeKeys = new Set<string>();

    if (typeof value === "object" && value !== null && !Array.isArray(value)) {
      for (
        const [key, val] of Object.entries(value as Record<string, unknown>)
      ) {
        if (isVNode(val)) {
          const encodedKey = encodeFuseComponent(key);
          const fileName = `${encodedKey}.json`;
          currentVNodeKeys.add(encodedKey);
          const existing = this.tree.lookup(parentIno, fileName);
          if (existing !== undefined) this.tree.clear(existing);
          const vnodeIno = this.tree.addFile(
            parentIno,
            fileName,
            safeStringify(val),
            "object",
          );
          const contentLabel = annotator?.subtreeLabel(val, [key]);
          this.annotateSyntheticNode(
            annotator,
            vnodeIno,
            "aggregate-json",
            [key],
            { ino: parentIno, name: fileName },
            contentLabel,
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
    annotator?: CfcProjectionAnnotator,
  ): void {
    const existingIno = this.tree.lookup(pieceIno, ".handlers");
    if (existingIno !== undefined) this.tree.clear(existingIno);
    if (callables.length === 0) return;
    const lines = callables.map(({ key, callableKind, schema }) => {
      const typeStr = displayCallableInputType(callableKind, schema);
      return `${key}.${callableKind}  ${typeStr}`;
    });
    const handlersIno = this.tree.addFile(
      pieceIno,
      ".handlers",
      lines.join("\n") + "\n",
      "string",
    );
    const schemaLabels = callables.map(({ key, schema }) =>
      schema === undefined ? undefined : annotator?.subtreeLabel(schema, [key])
    );
    this.annotateSyntheticNode(
      annotator,
      handlersIno,
      "piece-meta",
      [".handlers"],
      { ino: pieceIno, name: ".handlers" },
      joinLabels(...schemaLabels),
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
    annotator?: CfcProjectionAnnotator,
  ): (parentIno: bigint, name: string, value: unknown) => void {
    return (parentIno, name, value) => {
      const classifyFsEntry = (key: string, candidate: unknown) =>
        skipEntry(candidate) ? classifyEntry(key, candidate) : null;
      buildJsonTree(
        this.tree,
        parentIno,
        name,
        value,
        undefined,
        resolveLink,
        0,
        skipEntry,
        classifyFsEntry,
        annotator?.jsonContext([name]),
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
   * Subscribe to cell changes for hydration-cache invalidation and
   * projected name changes for a piece.
   */
  private async subscribePiece(
    piece: PieceController,
    pieceIno: bigint,
    pieceName: string,
    spaceName: string,
    state: SpaceState,
  ): Promise<Cancel[]> {
    const cancels: Cancel[] = [];

    // Subscribe to input/result cell changes so the hydration cache is
    // invalidated when external mutations arrive (background recomputes,
    // remote writes, etc.). The invalidation is debounced: the reactive
    // graph may fire multiple intermediate updates before settling.
    const resolveLink = this.makeLinkResolver(spaceName);
    for (const propName of ["input", "result"] as const) {
      try {
        const cell = await piece[propName].getCell();
        let debounceTimer: ReturnType<typeof setTimeout> | undefined;
        const cancel = cell.sink((newValue: unknown) => {
          if (debounceTimer !== undefined) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            debounceTimer = undefined;
            void (async () => {
              let rebuildValue = newValue;
              if (rebuildValue === undefined) {
                if (typeof cell.pull === "function") {
                  await cell.pull().catch(() => undefined);
                }
                rebuildValue = await piece[propName].get().catch(() =>
                  undefined
                );
              }
              if (rebuildValue === undefined) {
                return;
              }
              // Eagerly rebuild using the sink payload when available. Under
              // pull mode the sink can briefly report undefined before an
              // explicit pull materializes the latest result, so fall back to
              // the piece getter in that case. If the value is still
              // undefined, keep the current mounted tree intact until a
              // concrete replacement arrives.
              //
              // The rebuild reconciles onto the mounted tree in place, so the
              // tree is not torn down first; advancing the hydration epoch is
              // enough to make an in-flight hydration re-read the new value.
              this.bumpHydrationEpoch(pieceIno, propName);
              await this.enqueuePiecePropRebuild({
                cell,
                newValue: rebuildValue,
                pieceId: piece.id,
                pieceIno,
                pieceName: piece.name() || pieceName,
                propName,
                resolveLink,
                spaceName,
              });
            })().catch((e) => {
              console.error(
                `[${spaceName}] Error rebuilding ${pieceName}/${propName}: ${e}`,
              );
            });
          }, 150);
        });
        cancels.push(() => {
          cancel();
          if (debounceTimer !== undefined) {
            clearTimeout(debounceTimer);
            debounceTimer = undefined;
          }
        });
      } catch (e) {
        console.error(
          `[${spaceName}] Could not subscribe to ${pieceName}.${propName}: ${e}`,
        );
      }
    }

    // Pattern hot-swaps (system roll-forward, CLI setsrc, or FUSE source
    // edits) and repository annotation changes retain the same piece entity.
    // Keep the synthetic reference in meta.json and pieces.json aligned with
    // the currently running artifact and its source locator.
    const getRootCell = (piece as unknown as {
      getCell?: () => Cell<unknown>;
    }).getCell;
    if (typeof getRootCell === "function") {
      try {
        const rootCell = getRootCell.call(piece) as Cell<unknown> & {
          sinkMeta?: Cell<unknown>["sinkMeta"];
        };
        if (typeof rootCell.sinkMeta === "function") {
          for (
            const key of ["patternIdentity", "patternRepository"] as const
          ) {
            const cancelPatternRef = rootCell.sinkMeta(
              key,
              () => {
                void this.refreshPiecePatternMetadata(
                  state,
                  piece,
                  pieceIno,
                ).catch((e) => {
                  console.error(
                    `[${spaceName}] Could not refresh ${pieceName} pattern reference: ${e}`,
                  );
                });
              },
            );
            cancels.push(cancelPatternRef);
          }
        }
      } catch (e) {
        console.error(
          `[${spaceName}] Could not subscribe to ${pieceName} pattern reference: ${e}`,
        );
      }
    }

    // Subscribe to the result cell to detect [NAME] changes and rename the
    // piece directory in the FUSE tree accordingly.
    // We use the result cell (not the root entity cell) because [NAME] is part
    // of the pattern's result output, and the scheduler tracks result cell
    // reads when setting up reactive subscriptions.
    try {
      const nameTrackingCell = await piece.result.getCell();
      const cancelRootSub = nameTrackingCell.sink((newValue: unknown) => {
        setTimeout(() => {
          try {
            // Use the state captured at subscription time, NOT
            // this.spaces.get(): during the initial buildSpaceTree the space
            // isn't registered in this.spaces yet, so a lookup would silently
            // drop every name event that fires while the tree is being built
            // (and a static piece may never fire again). Only bail if the
            // space has since been disconnected or replaced.
            const registered = this.spaces.get(spaceName);
            if (registered !== undefined && registered !== state) return;

            // Find the piece's current FUSE name by searching pieceMap.
            let currentName: string | undefined;
            for (const [name, id] of state.pieceMap) {
              if (id === piece.id) {
                currentName = name;
                break;
              }
            }
            if (currentName === undefined) return;

            // Read $NAME from the sink value directly — piece.name() may
            // return a stale cached value that hasn't updated yet.
            const sinkName = typeof newValue === "object" && newValue !== null
              ? (newValue as Record<string, unknown>)["$NAME"]
              : undefined;
            const rawName = typeof sinkName === "string"
              ? sinkName
              : (piece.name() ?? piece.id);
            const normalizedRawName = resolveProjectedPieceName(
              rawName,
              piece.id,
            );

            this.debugLog(
              `[${spaceName}] Rename check: current=${currentName} raw=${rawName} normalized=${normalizedRawName}`,
            );

            // Skip if the name hasn't changed.
            if (
              rawName === currentName ||
              normalizedRawName === currentName
            ) return;

            // Collision-resolve the new name. We need to exclude currentName
            // from the used-name check (the piece is vacating it), but we
            // must NOT mutate usedNames until after tree.rename() succeeds —
            // a thrown rename would otherwise leave tracking inconsistent.
            let newName = normalizedRawName;
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
            const trackedPieceIno = state.pieceInos.get(currentName);
            state.pieceInos.delete(currentName);
            if (trackedPieceIno !== undefined) {
              state.pieceInos.set(newName, trackedPieceIno);
              const rootInfo = this.pieceRoots.get(trackedPieceIno);
              if (rootInfo) {
                rootInfo.rootName = newName;
              }
            }
            state.pieceControllers.delete(currentName);
            if (controller !== undefined) {
              state.pieceControllers.set(newName, controller);
            }
            state.pieceSubs.delete(currentName);
            if (subs !== undefined) {
              state.pieceSubs.set(newName, subs);
            }
            const srcIno = state.srcInos.get(currentName);
            state.srcInos.delete(currentName);
            if (srcIno !== undefined) state.srcInos.set(newName, srcIno);
            const errorLogIno = state.srcErrorLogInos.get(currentName);
            state.srcErrorLogInos.delete(currentName);
            if (errorLogIno !== undefined) {
              state.srcErrorLogInos.set(newName, errorLogIno);
            }

            const renamedPieceIno = this.tree.lookup(state.piecesIno, newName);
            if (renamedPieceIno !== undefined) {
              this.updatePieceMetaName(renamedPieceIno, newName);
            }
            const entityIno = this.tree.lookup(
              state.entitiesIno,
              encodeFuseComponent(piece.id),
            );
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

      const rawLinkData: unknown = linkRefPayload(value);
      if (
        typeof rawLinkData !== "object" || rawLinkData === null ||
        Array.isArray(rawLinkData)
      ) {
        return null;
      }
      const linkData = rawLinkData as {
        id?: unknown;
        path?: unknown;
        space?: unknown;
      };
      if (linkData.id !== undefined && typeof linkData.id !== "string") {
        return null;
      }
      if (
        linkData.space !== undefined && typeof linkData.space !== "string"
      ) {
        return null;
      }
      if (
        linkData.path !== undefined &&
        (!Array.isArray(linkData.path) ||
          !linkData.path.every((part) => typeof part === "string"))
      ) {
        return null;
      }

      const encodedPath = Array.isArray(linkData.path)
        ? encodeFusePathSegments(linkData.path as string[])
        : undefined;
      const pathSuffix = encodedPath?.length ? "/" + encodedPath.join("/") : "";

      if (!linkData.id) {
        // Self-reference: just the path relative to piece root
        return encodedPath?.length ? encodedPath.join("/") : null;
      }

      const entityHash = encodeFuseComponent(linkData.id);
      // depth is relative to the piece dir (input/ or result/ adds 1)
      // We need to go up to the space dir: up from current depth + up past piece name + up past "pieces"
      const upToSpace = "../".repeat(depth + 2);

      if (linkData.space && linkData.space !== spaceName) {
        // Cross-space: go up to mount root, then into other space
        return upToSpace + "../" + encodeFuseComponent(linkData.space) +
          "/entities/" + entityHash + pathSuffix;
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
    rootKind: "pieces" | "entities" = "pieces",
  ): Promise<bigint> {
    const pieceIno = existingIno ?? this.tree.addDir(parentIno, name);

    // Create meta.json first so it's always present
    let patternRef: PiecePatternRef | undefined;
    try {
      patternRef = await piece.getPatternRef();
    } catch {
      // Pattern metadata is best-effort; keep the piece mount available.
    }
    const metaObject = {
      id: piece.id,
      entityId: piece.id,
      name: piece.name() || "",
      ...(patternRef === undefined ? {} : { patternRef }),
    };
    const pieceAnnotator = this.makeCfcAnnotator({
      spaceName,
      pieceId: piece.id,
      rootKind,
      value: metaObject,
    });
    pieceAnnotator?.annotateJsonDirectory(pieceIno, [], {});
    pieceAnnotator?.annotateEntry(parentIno, name, pieceIno);

    // Clear existing meta.json if reusing a stub dir (avoids orphaned inode)
    const existingMetaIno = this.tree.lookup(pieceIno, "meta.json");
    if (existingMetaIno !== undefined) this.tree.clear(existingMetaIno);

    const metaIno = this.tree.addFile(
      pieceIno,
      "meta.json",
      JSON.stringify(metaObject, null, 2),
      "object",
    );
    this.annotateSyntheticNode(
      pieceAnnotator,
      metaIno,
      "piece-meta",
      ["meta.json"],
      { ino: pieceIno, name: "meta.json" },
    );
    this.registerPieceRoot(pieceIno, {
      spaceName,
      rootKind,
      rootName: name,
      pieceId: piece.id,
      piece,
    });
    this.ensurePiecePropStub(
      pieceIno,
      "input",
      this.makeCfcAnnotator({
        spaceName,
        pieceId: piece.id,
        rootKind,
        cell: "input",
        value: {},
      }),
    );
    this.ensurePiecePropStub(
      pieceIno,
      "result",
      this.makeCfcAnnotator({
        spaceName,
        pieceId: piece.id,
        rootKind,
        cell: "result",
        value: {},
      }),
    );

    return pieceIno;
  }

  /**
   * Build the .src/ subtree for a piece, containing all of the pattern's
   * authored source files (recovered from the content-addressed
   * `pattern:<identity>` source-doc closure). Skips system pieces that have no
   * recoverable source.
   */
  private async buildSourceTree(
    pieceIno: bigint,
    piece: PieceController,
    state: SpaceState,
    pieceName: string,
  ): Promise<void> {
    let sourceFiles: { name: string; contents: string }[] | undefined;
    try {
      sourceFiles = await piece.getPatternSourceFiles();
    } catch {
      // Pattern source not always available
    }

    if (!sourceFiles?.length) {
      // System piece or no source — skip .src/
      return;
    }
    const files = sourceFiles;

    const annotator = this.makeCfcAnnotator({
      spaceName: this.spaceNameForState(state) ?? state.did,
      spaceDid: state.did,
      pieceId: piece.id,
      rootKind: "pieces",
      value: { files },
    });

    // Create or reuse .src/ dir
    let srcIno = this.tree.lookup(pieceIno, ".src");
    if (srcIno !== undefined) {
      this.tree.clear(srcIno);
    }
    srcIno = this.tree.addDir(pieceIno, ".src");
    annotator?.annotateJsonDirectory(srcIno, [".src"], {});
    annotator?.annotateEntry(pieceIno, ".src", srcIno, { labelPath: [".src"] });
    state.srcInos.set(pieceName, srcIno);

    // Add each source file at its relative path
    const enc = new TextEncoder();
    for (const file of files) {
      const relPath = file.name.startsWith("/")
        ? file.name.slice(1)
        : file.name;
      const parts = relPath.split("/");
      const encodedParts = encodeFusePathSegments(parts);
      let parentIno = srcIno;
      // Create intermediate directories
      for (let i = 0; i < parts.length - 1; i++) {
        const encodedPart = encodedParts[i];
        const existing = this.tree.lookup(parentIno, encodedPart);
        if (existing !== undefined) {
          parentIno = existing;
        } else {
          const dirIno = this.tree.addDir(parentIno, encodedPart);
          const dirPath = [".src", ...parts.slice(0, i + 1)];
          annotator?.annotateJsonDirectory(dirIno, dirPath, {});
          annotator?.annotateEntry(parentIno, encodedPart, dirIno, {
            labelPath: dirPath,
          });
          parentIno = dirIno;
        }
      }
      const fileName = encodedParts[encodedParts.length - 1];
      const sourceIno = this.tree.addFile(
        parentIno,
        fileName,
        enc.encode(file.contents),
        "string",
      );
      const sourcePath = [".src", ...parts];
      this.annotateSyntheticNode(
        annotator,
        sourceIno,
        "source",
        sourcePath,
        { ino: parentIno, name: fileName },
      );
    }

    // Add synthetic error.log only if no source file already claimed that name.
    // Track its inode so we can block writes to the synthetic file specifically
    // (a real source file named error.log must remain writable).
    if (this.tree.lookup(srcIno, "error.log") === undefined) {
      const errorLogIno = this.tree.addFile(srcIno, "error.log", "", "string");
      this.annotateSyntheticNode(
        annotator,
        errorLogIno,
        "source",
        [".src", "error.log"],
        { ino: srcIno, name: "error.log" },
      );
      state.srcErrorLogInos.set(pieceName, errorLogIno);
    }
    this.noteCfcProjectionRebuilt();
  }
}
