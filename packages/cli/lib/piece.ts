import { createSession, isDID, Session } from "@commonfabric/identity";
import { ensureDir } from "@std/fs";
import { caseFold } from "unicode-case-folding";
import { loadIdentity } from "./identity.ts";
import {
  Cell,
  entityIdFrom,
  experimentalOptionsFromEnv,
  formatFabricRef,
  getCellOrThrow,
  getMetaLink,
  getPatternIdentityRef,
  isCell,
  isCellResult,
  isReadableCell,
  isSlugAddress,
  NAME,
  Runtime,
  runtimePresets,
  RuntimeProgram,
  UI,
  VNode,
} from "@commonfabric/runner";
import { validateSchemaValue } from "@commonfabric/runner/cfc";
import type { CellScope, JSONSchema } from "@commonfabric/api";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  assignSlug,
  pieceId,
  PieceManager,
  resolvePieceAddress as resolveStoredPieceAddress,
  resolveSlugTargetCell,
  setSlugLink,
  SlugResolutionError,
} from "@commonfabric/piece";
import {
  type PiecePatternRef,
  PiecesController,
} from "@commonfabric/piece/ops";
import { dirname, join } from "@std/path";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { setLLMUrl } from "@commonfabric/llm";
import { FabricSpecialObject } from "@commonfabric/data-model/fabric-value";
import { codecOf } from "@commonfabric/data-model/codec-common";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { getCarriedCfcLabelView } from "@commonfabric/runner/cfc";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isPlainObject, isRecord } from "@commonfabric/utils/types";
import { pinProgramFabricImports, renderPinRewrite } from "./fabric-deps.ts";
import { isHandlerCell } from "../../fuse/callables.ts";
import { awaitSyncWithTimeout } from "./utils.ts";
import {
  callableCommandSpec,
  type CallableExecutionDeps,
  type CallableResolution,
  type CallableResultRef,
  CF_RUNTIME_ERROR_LOG,
  type CliRuntimeErrorRecord,
  detectCallableKind,
  executeResolvedCallable,
  runtimeErrorLog,
} from "./callable.ts";
import { executeCallableCommand } from "./callable-command.ts";
import {
  type ExecCommandSpec,
  type ParsedExecArgs,
  renderExecHelpJson,
  renderPieceCallHelp,
} from "./exec-schema.ts";
import { cliCommand } from "./cli-name.ts";
import { deriveDiskHandleId } from "./sqlite-source.ts";

export interface EntryConfig {
  mainPath: string;
  mainExport?: string;
  repository?: string;
  rootPath?: string;
}

export interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
}

/** Metadata returned for a piece whose stored data matches a search query. */
export interface PieceSearchResult {
  id: string;
  name?: string;
  patternRef?: PiecePatternRef;
}

export interface PieceConfig extends SpaceConfig {
  piece: string;
  pieceScope?: CellScope;
}

export interface SetPiecePatternOptions {
  dangerouslyAllowIncompatibleSchema?: boolean;
}

export interface GetCellValueOptions {
  input?: boolean;
  step?: boolean;
}

export class PieceResultProjectionError extends Error {
  constructor(path: readonly (string | number)[], stepped: boolean) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    const stepHint = stepped
      ? " The piece was stepped, but the required value still did not " +
        "materialize."
      : " Use --step to start the piece and materialize session-scoped " +
        "computed values before reading.";
    super(
      `Cannot read piece result at "${location}": stored data is present, ` +
        `but its schema could not resolve all required values.${stepHint}`,
    );
    this.name = "PieceResultProjectionError";
  }
}

async function resultProjectionFailedAtPath(
  piece: {
    result: { getCell(): Promise<Cell<unknown>> };
  },
  path: readonly (string | number)[],
): Promise<boolean> {
  const rootCell = await piece.result.getCell();
  let targetCell = rootCell;
  for (const segment of path) {
    targetCell = targetCell.key(segment as keyof unknown) as Cell<unknown>;
  }
  const schema = targetCell.schema;
  if (targetCell.getRaw() === undefined || schema === undefined) {
    return false;
  }
  return validateSchemaValue(
    schema,
    undefined,
    rootCell.schema ?? schema,
  ) !== undefined;
}

export interface ResolvedPieceCallable extends CallableResolution {
  commandSpec: ExecCommandSpec;
}

export interface PieceCallableDependencies extends CallableExecutionDeps {
  helpCommandPrefix?: string;
  loadManager?: (config: SpaceConfig) => Promise<any>;
  loadPiece?: (
    manager: any,
    pieceId: string,
    scope?: PieceConfig["pieceScope"],
  ) => Promise<any>;
  readJsonInput?: () => Promise<unknown>;
  readTextInput?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  isStdinTerminal?: () => boolean;
}

export interface ExecutedPieceCallable {
  helpText?: string;
  outputText?: string;
  /** Tool result cell address, passed through from ExecutedCallable. */
  resultRef?: CallableResultRef;
  parsed: ParsedExecArgs;
  resolved: ResolvedPieceCallable;
}

export interface PieceResolutionDeps {
  loadManager?: typeof loadManager;
  resolvePieceAddress?: (
    manager: PieceManager,
    token: string,
  ) => Promise<string>;
}

interface PieceOperationDependencies extends PieceResolutionDeps {
  loadIdentity?: typeof loadIdentity;
  getProgramFromFile?: typeof getProgramFromFile;
  getPinnedProgramFromFile?: typeof getPinnedProgramFromFile;
  createController?: (manager: PieceManager) => PiecesController;
  reportSearchError?: (
    pieceId: string,
    source: "input data" | "result data" | "metadata",
    error: unknown,
  ) => void;
}

const CLI_TRACE_TIMINGS = Deno.env.get("CF_CLI_TRACE_TIMINGS") === "1";

interface DisposableRuntime {
  dispose(): Promise<unknown>;
  storageManager?: unknown;
}

function storageManagerCloseNow(
  storageManager: unknown,
): (() => Promise<unknown>) | undefined {
  if (
    typeof storageManager === "object" && storageManager !== null &&
    "closeNow" in storageManager
  ) {
    const closeNow = Reflect.get(storageManager, "closeNow");
    if (typeof closeNow === "function") {
      return () => Promise.resolve(closeNow.call(storageManager));
    }
  }
  return undefined;
}

export async function withRuntimeCleanupOnFailure<T>(
  runtime: DisposableRuntime,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    const closeNow = storageManagerCloseNow(runtime.storageManager);
    if (closeNow) {
      await closeNow().catch((disposeError) => {
        console.warn(
          `loadManager storage cleanup failed: ${
            disposeError instanceof Error
              ? disposeError.message
              : String(disposeError)
          }`,
        );
      });
    }
    await runtime.dispose().catch(
      (disposeError) => {
        console.warn(
          `loadManager cleanup failed: ${
            disposeError instanceof Error
              ? disposeError.message
              : String(disposeError)
          }`,
        );
      },
    );
    throw error;
  }
}

async function timeCliPhase<T>(
  label: string,
  run: () => T | Promise<T>,
): Promise<T> {
  if (!CLI_TRACE_TIMINGS) {
    return await run();
  }
  const start = performance.now();
  try {
    return await run();
  } finally {
    const elapsed = Math.round(performance.now() - start);
    console.error(`[cf-phase] ${elapsed}ms :: ${label}`);
  }
}

async function makeSession(config: SpaceConfig): Promise<Session> {
  const identity = await loadIdentity(config.identity);
  if (isDID(config.space)) {
    return createSession({ identity, spaceDid: config.space });
  } else {
    return createSession({ identity, spaceName: config.space });
  }
}

export async function loadManager(config: SpaceConfig): Promise<PieceManager> {
  setLLMUrl(config.apiUrl);
  const session = await timeCliPhase(
    "loadManager.makeSession",
    () => makeSession(config),
  );
  // Use a const ref object so we can assign later while keeping const binding
  const pieceManagerRef: { current?: PieceManager } = {};
  const runtimeErrors: CliRuntimeErrorRecord[] = [];
  const runtime = await timeCliPhase(
    "loadManager.runtime",
    () =>
      // Shared first-party posture for client runtimes against a deployed
      // API (CT-1814); collectors and the navigate hook are this CLI's
      // declared deltas.
      new Runtime(runtimePresets.remoteClient({
        apiUrl: new URL(config.apiUrl),
        storageManager: StorageManager.open({
          as: session.as,
          memoryHost: new URL(config.apiUrl),
          spaceIdentity: session.spaceIdentity,
        }),
        experimental: experimentalOptionsFromEnv(Deno.env.get),
        errorHandlers: [
          (error) => {
            runtimeErrors.push({
              message: error.message,
              pieceId: error.pieceId,
              patternId: error.patternId,
              spellId: error.spellId,
              space: error.space,
              stackTrace: error.stack,
            });
          },
        ],
        navigateCallback: (target) => {
          try {
            const id = pieceId(target);
            if (!id) {
              console.error("navigateTo: target missing piece id");
              return;
            }
            // Emit greppable line immediately so scripts can capture without waiting
            console.log(`navigateTo new piece id ${id}`);
            // Best-effort: ensure piece is present in list
            runtime.storageManager
              .synced()
              .then(async () => {
                try {
                  const mgr = pieceManagerRef.current!;
                  const piecesCell = await mgr.getPieces();
                  const list = piecesCell.get();
                  const exists = list.some((c) => pieceId(c) === id);
                  if (!exists) {
                    await mgr.add([target]);
                  }
                } catch (e) {
                  console.error("navigateTo add error:", e);
                }
              })
              .catch((_err: unknown) => {
                // ignore; we already emitted the id
              });
          } catch (e) {
            console.error("navigateTo callback error:", e);
          }
        },
      })),
  );
  (runtime as Runtime & { [CF_RUNTIME_ERROR_LOG]?: CliRuntimeErrorRecord[] })[
    CF_RUNTIME_ERROR_LOG
  ] = runtimeErrors;

  return await withRuntimeCleanupOnFailure(runtime, async () => {
    if (
      !(await timeCliPhase(
        "loadManager.healthCheck",
        () => runtime.healthCheck(),
      ))
    ) {
      throw new Error(`Could not connect to "${config.apiUrl.toString()}".`);
    }

    const pieceManager = await timeCliPhase(
      "loadManager.pieceManager",
      () => new PieceManager(session, runtime),
    );
    pieceManagerRef.current = pieceManager;
    await timeCliPhase(
      "loadManager.synced",
      () => awaitSyncWithTimeout(pieceManager.synced()),
    );
    return pieceManager;
  });
}

export async function getProgramFromFile(
  manager: PieceManager,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  const program: RuntimeProgram = await manager.runtime.harness.resolve(
    new FileSystemProgramResolver(entry.mainPath, entry.rootPath),
  );
  if (entry.mainExport) {
    program.mainExport = entry.mainExport;
  }
  return program;
}

async function getPinnedProgramFromFile(
  manager: PieceManager,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  const program = await getProgramFromFile(manager, entry);
  const result = await pinProgramFabricImports(
    manager.runtime,
    manager.getSpace(),
    program,
  );
  for (const rewrite of result.rewrites) {
    console.error(renderPinRewrite(rewrite));
  }
  return result.program;
}

// Returns an array of metadata about pieces to display.
export async function listPieces(
  config: SpaceConfig,
  deps: PieceOperationDependencies = {},
): Promise<
  { id: string; name?: string; patternRef?: PiecePatternRef; error?: string }[]
> {
  const manager = await (deps.loadManager ?? loadManager)(config);
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);
  const allPieces = await pieces.getAllPieces();
  return Promise.all(
    allPieces.map(async (piece) => {
      try {
        const livePiece = await pieces.get(piece.id, true);
        const name = (await (
          livePiece.getCell().key(NAME) as Cell<unknown>
        ).pull()) as string | undefined;
        const patternRef = await livePiece.getPatternRef();
        return {
          id: piece.id,
          name,
          patternRef,
        };
      } catch (err) {
        return {
          id: piece.id,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }),
  );
}

const PIECE_SEARCH_CONCURRENCY = 4;
const NO_IGNORED_ROOT_KEYS = new Set<string>();
const RESULT_IGNORED_ROOT_KEYS = new Set([NAME]);
const SEARCH_GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, {
  granularity: "grapheme",
});

function foldSearchText(value: string): string {
  return caseFold(value.normalize("NFD")).normalize("NFD");
}

function foldedSearchTextContains(value: string, query: string): boolean {
  const foldedSegments: string[] = [];
  const boundaries = new Set<number>([0]);
  let foldedLength = 0;

  for (
    const { segment } of SEARCH_GRAPHEME_SEGMENTER.segment(
      value.normalize("NFC"),
    )
  ) {
    const foldedSegment = foldSearchText(segment);
    const segmentStart = foldedLength;
    foldedSegments.push(foldedSegment);
    foldedLength += foldedSegment.length;
    boundaries.add(foldedLength);

    const foldedCodePoints = Array.from(segment, foldSearchText);
    if (foldedCodePoints.join("") === foldedSegment) {
      let codePointBoundary = segmentStart;
      for (let index = 0; index < foldedCodePoints.length - 1; index++) {
        codePointBoundary += foldedCodePoints[index].length;
        boundaries.add(codePointBoundary);
      }
    }
  }

  const foldedValue = foldedSegments.join("");
  for (
    let match = foldedValue.indexOf(query);
    match !== -1;
    match = foldedValue.indexOf(query, match + 1)
  ) {
    if (boundaries.has(match) && boundaries.has(match + query.length)) {
      return true;
    }
  }
  return false;
}

function cellTraversalKey(cell: Cell<unknown>): string {
  const link = cell.getAsNormalizedFullLink();
  return hashStringOf({
    link,
    cfcLabelView: getCarriedCfcLabelView(cell),
  });
}

function cellDocumentTraversalKey(cell: Cell<unknown>): string {
  const { space, id, scope } = cell.getAsNormalizedFullLink();
  return hashStringOf({
    link: { space, id, scope, path: [] },
    cfcLabelView: getCarriedCfcLabelView(cell),
  });
}

function cellValueTraversalKey(cell: Cell<unknown>): string {
  const { space, id, scope, path } = cell.getAsNormalizedFullLink();
  return hashStringOf({
    link: { space, id, scope, path },
    cfcLabelView: getCarriedCfcLabelView(cell),
  });
}

interface PieceOwnerCache {
  cells: Map<string, Promise<string | undefined>>;
  documents: Map<string, string | null>;
}

async function resolveRegisteredDocumentOwner(
  cell: Cell<unknown>,
  registeredPieceIds: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
): Promise<string | undefined> {
  let current = cell;
  const visited = new Set<string>();
  const traversed: string[] = [];

  const finish = (owner: string | undefined): string | undefined => {
    for (const key of traversed) {
      ownerCache.documents.set(key, owner ?? null);
    }
    return owner;
  };

  while (true) {
    const key = cellDocumentTraversalKey(current);
    if (visited.has(key)) {
      throw new Error(
        `Cycle found while resolving piece ownership for ${
          pieceId(cell) ?? "an unknown Cell"
        }`,
      );
    }
    if (ownerCache.documents.has(key)) {
      return finish(ownerCache.documents.get(key) ?? undefined);
    }
    visited.add(key);
    traversed.push(key);

    const currentId = pieceId(current);
    // Nested piece results can point to a parent result. Stop at the nearest
    // registered result before following its parent metadata.
    if (currentId !== undefined && registeredPieceIds.has(currentId)) {
      return finish(currentId);
    }

    await current.sync();
    const argumentLink = getMetaLink(current, "argument");
    if (
      currentId !== undefined &&
      (getPatternIdentityRef(current) !== undefined ||
        argumentLink !== undefined)
    ) {
      return finish(currentId);
    }
    const resultLink = getMetaLink(current, "result");
    if (resultLink === undefined) return finish(undefined);

    current = current.runtime.getCellFromLink(
      { ...resultLink, path: [], schema: undefined },
      undefined,
      current.tx,
      getCarriedCfcLabelView(current),
    );
  }
}

function registeredDocumentOwner(
  cell: Cell<unknown>,
  registeredPieceIds: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
): Promise<string | undefined> {
  const key = cellDocumentTraversalKey(cell);
  if (ownerCache.documents.has(key)) {
    return Promise.resolve(ownerCache.documents.get(key) ?? undefined);
  }
  return resolveRegisteredDocumentOwner(
    cell,
    registeredPieceIds,
    ownerCache,
  );
}

async function resolveRegisteredPieceOwner(
  cell: Cell<unknown>,
  registeredPieceIds: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
  cellIsMaterialized: boolean,
): Promise<string | undefined> {
  if (!cellIsMaterialized) await cell.sync();
  return registeredDocumentOwner(
    cell.resolveAsCell(),
    registeredPieceIds,
    ownerCache,
  );
}

function registeredPieceOwner(
  cell: Cell<unknown>,
  registeredPieceIds: ReadonlySet<string>,
  ownerCache: PieceOwnerCache,
  cellIsMaterialized: boolean,
): Promise<string | undefined> {
  const key = cellTraversalKey(cell);
  let owner = ownerCache.cells.get(key);
  if (owner === undefined) {
    owner = resolveRegisteredPieceOwner(
      cell,
      registeredPieceIds,
      ownerCache,
      cellIsMaterialized,
    );
    ownerCache.cells.set(key, owner);
  }
  return owner;
}

interface SearchOwnership {
  pieceId: string;
  registeredPieceIds: ReadonlySet<string>;
  ownerCache: PieceOwnerCache;
}

type SearchEntry =
  | { key: string }
  | {
    value: unknown;
    ownershipEstablished?: boolean;
    sourceCell?: Cell<unknown>;
    isRoot?: boolean;
  };

function* singleSearchEntry(
  value: unknown,
  ownershipEstablished = false,
  sourceCell?: Cell<unknown>,
  isRoot = false,
): IterableIterator<SearchEntry> {
  yield { value, ownershipEstablished, sourceCell, isRoot };
}

function* arraySearchEntries(
  value: unknown[],
  ignoredKeys: ReadonlySet<string>,
  sourceCell?: Cell<unknown>,
  reportReadError?: (error: unknown) => void,
): IterableIterator<SearchEntry> {
  for (const key in value) {
    try {
      if (!Object.hasOwn(value, key) || ignoredKeys.has(key)) continue;
      if (isArrayIndexPropertyName(key)) {
        const index = Number(key);
        const nested = value[index];
        yield { value: nested, sourceCell: sourceCell?.key(index) };
      } else {
        yield { key };
        const nested = (value as unknown as Record<string, unknown>)[key];
        yield { value: nested, sourceCell: sourceCell?.key(key) };
      }
    } catch (error) {
      reportReadError?.(error);
    }
  }
}

function* objectSearchEntries(
  value: object,
  ignoredKeys: ReadonlySet<string>,
  sourceCell?: Cell<unknown>,
  reportReadError?: (error: unknown) => void,
): IterableIterator<SearchEntry> {
  const record = value as Record<string, unknown>;
  for (const key in value) {
    try {
      if (!Object.hasOwn(value, key) || ignoredKeys.has(key)) continue;
      yield { key };
      const nested = record[key];
      yield { value: nested, sourceCell: sourceCell?.key(key) };
    } catch (error) {
      reportReadError?.(error);
    }
  }
}

async function searchTextMatches(
  rootCell: Cell<unknown>,
  query: string,
  ownership: SearchOwnership,
  ignoredRootKeys: ReadonlySet<string> = NO_IGNORED_ROOT_KEYS,
  reportReadError?: (error: unknown) => void,
): Promise<boolean> {
  if (isCell(rootCell)) {
    const owner = await registeredPieceOwner(
      rootCell,
      ownership.registeredPieceIds,
      ownership.ownerCache,
      false,
    );
    if (owner !== undefined && owner !== ownership.pieceId) return false;
  }

  const value = await rootCell.pull();
  const pending: Iterator<SearchEntry>[] = [
    singleSearchEntry(
      value,
      true,
      isCell(rootCell) ? rootCell : undefined,
      true,
    ),
  ];
  const seen = new WeakSet<object>();
  const seenCells = new Set<string>();

  while (pending.length > 0) {
    let next: IteratorResult<SearchEntry>;
    try {
      next = pending[pending.length - 1].next();
    } catch (error) {
      pending.pop();
      reportReadError?.(error);
      continue;
    }
    if (next.done) {
      pending.pop();
      continue;
    }

    if ("key" in next.value) {
      if (foldedSearchTextContains(next.value.key, query)) return true;
      continue;
    }
    const current = next.value.value;

    if (current !== null && typeof current === "object" && isCell(current)) {
      if (!isReadableCell(current)) continue;

      try {
        const cellKey = cellTraversalKey(current);
        if (seenCells.has(cellKey)) continue;
        seenCells.add(cellKey);

        if (!next.value.ownershipEstablished) {
          const owner = await registeredPieceOwner(
            current,
            ownership.registeredPieceIds,
            ownership.ownerCache,
            false,
          );
          if (owner !== undefined && owner !== ownership.pieceId) continue;
        }

        const nested = await current.pull();
        if (nested !== current) {
          pending.push(singleSearchEntry(nested, true, current));
        }
      } catch (error) {
        reportReadError?.(error);
      }
      continue;
    }

    let sourceCell = next.value.sourceCell;
    let ownershipEstablished = next.value.ownershipEstablished ?? false;
    if (sourceCell !== undefined && !ownershipEstablished) {
      try {
        const owner = await registeredPieceOwner(
          sourceCell,
          ownership.registeredPieceIds,
          ownership.ownerCache,
          true,
        );
        if (owner !== undefined && owner !== ownership.pieceId) continue;
        ownershipEstablished = true;
      } catch (error) {
        reportReadError?.(error);
        continue;
      }
    }

    if (current === null || typeof current !== "object") {
      if (
        typeof current !== "function" &&
        foldedSearchTextContains(String(current), query)
      ) {
        return true;
      }
      continue;
    }

    if (isCellResult(current)) {
      try {
        const backingCell = getCellOrThrow(current);
        const valueWasPulledFromBackingCell = sourceCell !== undefined &&
          cellValueTraversalKey(sourceCell) ===
            cellValueTraversalKey(backingCell);
        sourceCell = backingCell;
        if (!ownershipEstablished) {
          const owner = await registeredPieceOwner(
            sourceCell,
            ownership.registeredPieceIds,
            ownership.ownerCache,
            true,
          );
          if (owner !== undefined && owner !== ownership.pieceId) continue;
          ownershipEstablished = true;
        }

        if (!valueWasPulledFromBackingCell) {
          const cellKey = cellTraversalKey(sourceCell);
          if (seenCells.has(cellKey)) continue;
          seenCells.add(cellKey);

          const materializedCell = sourceCell.asSchema(true);
          const nested = await materializedCell.pull();
          pending.push(singleSearchEntry(
            nested,
            true,
            materializedCell,
            next.value.isRoot,
          ));
          continue;
        }
      } catch (error) {
        reportReadError?.(error);
        continue;
      }
    }

    if (seen.has(current)) continue;
    seen.add(current);

    if (Array.isArray(current)) {
      pending.push(arraySearchEntries(
        current,
        next.value.isRoot ? ignoredRootKeys : NO_IGNORED_ROOT_KEYS,
        sourceCell,
        reportReadError,
      ));
      continue;
    }

    if (current instanceof FabricSpecialObject) {
      const representations: SearchEntry[] = [];
      if (current.toString !== Object.prototype.toString) {
        try {
          representations.push({ value: String(current) });
        } catch (error) {
          reportReadError?.(error);
        }
      }
      try {
        representations.push({ value: codecOf(current).encode(current) });
      } catch (error) {
        reportReadError?.(error);
      }
      if (representations.length > 0) {
        pending.push(representations[Symbol.iterator]());
      }
      continue;
    }

    if (!isPlainObject(current)) continue;
    pending.push(objectSearchEntries(
      current,
      next.value.isRoot ? ignoredRootKeys : NO_IGNORED_ROOT_KEYS,
      sourceCell,
      reportReadError,
    ));
  }

  return false;
}

/**
 * Find pieces with a full Unicode case-insensitive substring in their input or
 * result data. Matches begin and end at canonically normalized code-point
 * boundaries. Object keys and scalar values are searched recursively. Piece
 * metadata is returned for matching pieces but does not participate in
 * matching.
 */
export async function searchPieces(
  config: SpaceConfig,
  query: string,
  deps: PieceOperationDependencies = {},
): Promise<PieceSearchResult[]> {
  if (query.length === 0) {
    throw new Error("Search query must not be empty.");
  }

  const normalizedQuery = foldSearchText(query);
  // TODO(@ianh): Add an API for clients to initiate server-side searches
  // against a server-hosted index.
  const manager = await (deps.loadManager ?? loadManager)(config);
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);
  const allPieces = await pieces.getAllPieces();
  const registeredPieceIds = new Set(allPieces.map((piece) => piece.id));
  const ownerCache: PieceOwnerCache = {
    cells: new Map(),
    documents: new Map(),
  };
  const matches: Array<PieceSearchResult | undefined> = new Array(
    allPieces.length,
  );
  const reportSearchError = deps.reportSearchError ??
    ((
      pieceId: string,
      source: "input data" | "result data" | "metadata",
      error: unknown,
    ) => {
      console.warn(
        `Warning: Could not read ${source} for piece ${pieceId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    });
  let nextPieceIndex = 0;

  const searchNextPiece = async (): Promise<void> => {
    while (nextPieceIndex < allPieces.length) {
      const index = nextPieceIndex++;
      const piece = allPieces[index];

      let inputMatches = false;
      try {
        const inputCell = await piece.input.getCell();
        inputMatches = await searchTextMatches(
          inputCell,
          normalizedQuery,
          { pieceId: piece.id, registeredPieceIds, ownerCache },
          NO_IGNORED_ROOT_KEYS,
          (error) => reportSearchError(piece.id, "input data", error),
        );
      } catch (error) {
        reportSearchError(piece.id, "input data", error);
      }

      let resultMatches = false;
      if (!inputMatches) {
        try {
          const resultCell = await piece.result.getCell();
          resultMatches = await searchTextMatches(
            resultCell,
            normalizedQuery,
            { pieceId: piece.id, registeredPieceIds, ownerCache },
            RESULT_IGNORED_ROOT_KEYS,
            (error) => reportSearchError(piece.id, "result data", error),
          );
        } catch (error) {
          reportSearchError(piece.id, "result data", error);
        }
      }

      if (inputMatches || resultMatches) {
        let name: string | undefined;
        try {
          name = piece.name();
        } catch (error) {
          reportSearchError(piece.id, "metadata", error);
        }
        let patternRef: PiecePatternRef | undefined;
        try {
          patternRef = await piece.getPatternRef();
        } catch (error) {
          reportSearchError(piece.id, "metadata", error);
        }
        matches[index] = { id: piece.id, name, patternRef };
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(PIECE_SEARCH_CONCURRENCY, allPieces.length) },
      searchNextPiece,
    ),
  );

  return matches.filter((piece): piece is PieceSearchResult =>
    piece !== undefined
  );
}

async function resolvePieceConfigWithManager(
  config: PieceConfig,
  manager: PieceManager,
  resolver: PieceResolutionDeps["resolvePieceAddress"] =
    resolveStoredPieceAddress,
): Promise<PieceConfig> {
  return {
    ...config,
    piece: await resolver(manager, config.piece),
  };
}

export async function resolvePieceConfig(
  config: PieceConfig,
  deps: PieceResolutionDeps = {},
): Promise<PieceConfig> {
  const manager = await (deps.loadManager ?? loadManager)(config);
  return await resolvePieceConfigWithManager(
    config,
    manager,
    deps.resolvePieceAddress,
  );
}

export async function resolveLinkEndpointAddress(
  manager: PieceManager,
  token: string,
  resolver: PieceResolutionDeps["resolvePieceAddress"] =
    resolveStoredPieceAddress,
  options?: { allowMissingSlugFallback?: boolean },
): Promise<string> {
  try {
    return await resolver(manager, token);
  } catch (error) {
    if (
      options?.allowMissingSlugFallback &&
      error instanceof SlugResolutionError &&
      error.code === "missing" &&
      // Only fall back for an id-shaped token (one with a scheme/colon, e.g.
      // `fid1:…`). A bare slug-shaped token that didn't resolve is genuinely
      // missing — surface the clean SlugResolutionError rather than letting a
      // non-hash string reach `entityIdFrom`.
      !isSlugAddress(token)
    ) {
      return token;
    }
    throw error;
  }
}

// Creates a new piece from source code and optional input.
export async function newPiece(
  config: SpaceConfig,
  entry: EntryConfig,
  options?: { start?: boolean; slug?: string },
  deps: PieceOperationDependencies = {},
): Promise<string> {
  const manager = await timeCliPhase(
    "newPiece.loadManager",
    () => (deps.loadManager ?? loadManager)(config),
  );
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);

  // The default pattern is a hard requirement for this command: even when the
  // user's pattern doesn't use it, registration below (manager.add) sends an
  // event to the default pattern's addPiece stream. Proceeding past a failure
  // here can only end in "Cannot add pieces" — fail now, with the real cause.
  try {
    await timeCliPhase(
      "newPiece.ensureDefaultPattern",
      () => pieces.ensureDefaultPattern(),
    );
  } catch (error) {
    throw new Error(
      `Could not initialize the space's default pattern: ${
        error instanceof Error ? error.message : String(error)
      }\n` +
        `The new piece cannot be registered in the space's piece list ` +
        `without it.\n` +
        `If this space's root pattern predates a runtime format change, ` +
        `repair it with: ${cliCommand(["piece", "recreate-root"])}`,
      { cause: error },
    );
  }

  const program = await timeCliPhase(
    "newPiece.getProgramFromFile",
    () =>
      (deps.getPinnedProgramFromFile ?? getPinnedProgramFromFile)(
        manager,
        entry,
      ),
  );
  // A piece whose pattern never settles leaves `pieces.create` awaiting a
  // scheduler `idle()` that never resolves, and the runtime surfaces no
  // event that a start has definitively failed (a thrown pattern reports its
  // error and still resolves; a stuck async load reports nothing). This
  // wall-clock bound is the only thing that turns that hang into a message.
  // When it fires, report the actual runtime error the pattern recorded while
  // starting rather than only pointing at the server logs.
  const PIECE_START_TIMEOUT_MS = 60_000;
  const runtimeErrors = runtimeErrorLog(manager.runtime);
  const errorCountBefore = runtimeErrors.length;
  const piece = await timeCliPhase("newPiece.create", () => {
    const createPromise = pieces.create(program, {
      repository: entry.repository,
      start: options?.start,
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const recorded = runtimeErrors.slice(errorCountBefore).at(-1)?.message;
        const detail = recorded !== undefined
          ? `A runtime error was reported while it started: ${recorded}`
          : `Check toolshed logs for runtime errors.`;
        reject(
          new Error(
            `Piece created but failed to start within ${
              PIECE_START_TIMEOUT_MS / 1000
            }s. ${detail}`,
          ),
        );
      }, PIECE_START_TIMEOUT_MS);
    });
    return Promise.race([createPromise, timeout]).finally(() =>
      clearTimeout(timer)
    );
  });

  if (options?.slug) {
    await timeCliPhase(
      "newPiece.assignSlug",
      () => assignSlug(manager, piece.getCell(), options.slug!),
    );
  }

  // Explicitly add the piece to the space's allPieces list
  await timeCliPhase(
    "newPiece.addToDefaultPattern",
    () => manager.add([piece.getCell()]),
  );

  return piece.id;
}

export async function setPieceSlug(
  config: SpaceConfig,
  slug: string,
  sourcePieceId: string,
  sourcePath: (string | number)[],
  options?: {
    sourceScope?: PieceConfig["pieceScope"];
    resolveBeforeLinking?: boolean;
  },
): Promise<void> {
  const manager = await timeCliPhase(
    "setPieceSlug.loadManager",
    () => loadManager(config),
  );
  const resolvedSourcePieceId = await timeCliPhase(
    "setPieceSlug.resolveSource",
    () => resolveStoredPieceAddress(manager, sourcePieceId),
  );
  const source = sourcePath.length === 0
    ? manager.runtime.getCellFromEntityId(
      manager.getSpace(),
      entityIdFrom(resolvedSourcePieceId),
      [],
      undefined,
      undefined,
      options?.sourceScope,
    )
    : (await timeCliPhase(
      "setPieceSlug.getSourcePiece",
      () => {
        const pieces = new PiecesController(manager);
        return pieces.get(
          resolvedSourcePieceId,
          false,
          undefined,
          options?.sourceScope,
        );
      },
    )).getCell().key(...sourcePath);
  await timeCliPhase("setPieceSlug.source.sync", () => source.sync());
  await timeCliPhase(
    "setPieceSlug.setSlugLink",
    () =>
      setSlugLink(manager, slug, source, {
        resolveBeforeLinking: options?.resolveBeforeLinking,
        writeTargetMetadata: sourcePath.length === 0,
      }),
  );
}

export async function setPiecePattern(
  config: PieceConfig,
  entry: EntryConfig,
  options: SetPiecePatternOptions = {},
  deps: PieceOperationDependencies = {},
): Promise<void> {
  const manager = await (deps.loadManager ?? loadManager)(config);
  const resolvedConfig = await resolvePieceConfigWithManager(
    config,
    manager,
    deps.resolvePieceAddress,
  );
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  await piece.setPattern(
    await (deps.getPinnedProgramFromFile ?? getPinnedProgramFromFile)(
      manager,
      entry,
    ),
    {
      repository: entry.repository,
      ...(options.dangerouslyAllowIncompatibleSchema
        ? { dangerouslyAllowIncompatibleSchema: true }
        : {}),
    },
  );
}

export async function savePiecePattern(
  config: PieceConfig,
  outPath: string,
): Promise<void> {
  await ensureDir(outPath);
  const manager = await loadManager(config);
  const resolvedConfig = await resolvePieceConfigWithManager(config, manager);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const files = await piece.getPatternSourceFiles();

  if (files) {
    for (const { name, contents } of files) {
      if (name[0] !== "/") {
        throw new Error("Ungrounded file in pattern.");
      }
      const outFilePath = join(outPath, name.substring(1));
      await Deno.mkdir(dirname(outFilePath), { recursive: true });
      await Deno.writeTextFile(outFilePath, contents);
    }
  } else {
    throw new Error(
      `Piece "${resolvedConfig.piece}" does not contain a pattern source.`,
    );
  }
}

export async function applyPieceInput(config: PieceConfig, input: object) {
  const manager = await loadManager(config);
  const resolvedConfig = await resolvePieceConfigWithManager(config, manager);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  await piece.setInput(input);
}

function getCallableValue(rootValue: unknown, callableName: string): unknown {
  if (
    typeof rootValue !== "object" ||
    rootValue === null ||
    Array.isArray(rootValue)
  ) {
    return undefined;
  }
  return (rootValue as Record<string, unknown>)[callableName];
}

async function tryResolvePieceCallableAt(
  piece: any,
  manager: any,
  space: string,
  callableName: string,
  cellProp: "input" | "result",
): Promise<ResolvedPieceCallable | null> {
  const rootCell = await piece[cellProp].getCell();
  const callableCell = rootCell.key(callableName).asSchemaFromLinks();
  const callableKind = detectCallableKind(
    getCallableValue(rootCell.get?.(), callableName),
    callableCell,
  );
  if (!callableKind) {
    return null;
  }

  return {
    callableCell,
    callableKind,
    cellKey: callableName,
    cellProp,
    commandSpec: callableCommandSpec(callableCell, callableKind),
    manager,
    piece,
    space,
  };
}

async function tryResolvePieceHandler(
  piece: any,
  manager: any,
  space: string,
  callableName: string,
): Promise<ResolvedPieceCallable | null> {
  const pieceCell = piece.getCell?.();
  if (!pieceCell) {
    return null;
  }

  const streamRoot = pieceCell.asSchema({
    type: "object",
    properties: {
      [callableName]: { asCell: ["stream"] },
    },
    required: [callableName],
  });
  if (!isHandlerCell(streamRoot.key(callableName))) {
    return null;
  }

  const rootCell = await piece.result.getCell();
  const callableCell = rootCell.key(callableName).asSchemaFromLinks();
  return {
    callableCell,
    callableKind: "handler",
    cellKey: callableName,
    cellProp: "result",
    commandSpec: callableCommandSpec(callableCell, "handler"),
    manager,
    piece,
    space,
  };
}

async function tryResolveLivePieceToolCallable(
  piece: any,
  manager: any,
  space: string,
  callableName: string,
  pieceScope?: PieceConfig["pieceScope"],
): Promise<any | null> {
  if (
    typeof piece.getPattern !== "function" ||
    typeof piece.input?.get !== "function"
  ) {
    return null;
  }

  const pattern = await piece.getPattern();
  const input = await piece.input.get();
  const tx = manager.runtime.edit();
  const liveResult = manager.runtime.getCell(
    space,
    crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
    pieceScope,
  );
  manager.runtime.run(tx, pattern, input, liveResult);
  manager.runtime.prepareTxForCommit?.(tx);
  await tx.commit();
  await manager.runtime.idle();

  const callableCell = liveResult.key(callableName).asSchemaFromLinks();
  const callableKind = detectCallableKind(
    getCallableValue(liveResult.get?.(), callableName),
    callableCell,
  );
  return callableKind === "tool" ? callableCell : null;
}

/** Load the target piece and its manager for callable resolution/listing —
 * one shared path so `cf piece call` and `cf piece verbs` always see the same
 * piece state. */
async function loadPieceForCallables(
  config: PieceConfig,
  deps: PieceCallableDependencies = {},
): Promise<{
  manager: any;
  piece: any;
  space: string;
  resolvedConfig: Awaited<ReturnType<typeof resolvePieceConfigWithManager>>;
}> {
  const manager = await (deps.loadManager ?? loadManager)(config);
  const resolvedConfig = await resolvePieceConfigWithManager(config, manager);
  const pieces = new PiecesController(manager);

  if (!deps.loadPiece) {
    try {
      await pieces.ensureDefaultPattern();
    } catch (error) {
      console.warn(
        `Warning: Could not ensure default pattern: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const piece = await (deps.loadPiece
    ? deps.loadPiece(
      manager,
      resolvedConfig.piece,
      resolvedConfig.pieceScope,
    )
    : pieces.get(
      resolvedConfig.piece,
      true,
      undefined,
      resolvedConfig.pieceScope,
    ));
  const space = manager.getSpace?.() ?? config.space;
  return { manager, piece, space, resolvedConfig };
}

async function resolvePieceCallable(
  config: PieceConfig,
  callableName: string,
  deps: PieceCallableDependencies = {},
): Promise<ResolvedPieceCallable> {
  const { manager, piece, space, resolvedConfig } = await loadPieceForCallables(
    config,
    deps,
  );

  const resolved = (await tryResolvePieceCallableAt(
    piece,
    manager,
    space,
    callableName,
    "result",
  )) ??
    (await tryResolvePieceCallableAt(
      piece,
      manager,
      space,
      callableName,
      "input",
    )) ??
    (await tryResolvePieceHandler(piece, manager, space, callableName));
  if (!resolved) {
    throw new Error(
      `Callable "${callableName}" not found on piece ${config.piece}`,
    );
  }

  if (resolved.callableKind === "tool") {
    const liveCallableCell = await tryResolveLivePieceToolCallable(
      piece,
      manager,
      space,
      callableName,
      resolvedConfig.pieceScope,
    );
    if (liveCallableCell) {
      return {
        ...resolved,
        callableCell: liveCallableCell,
        commandSpec: callableCommandSpec(liveCallableCell, "tool"),
      };
    }
  }

  return resolved;
}

/** One row of `cf piece verbs`: a callable the piece exposes. */
export interface PieceCallableListing {
  name: string;
  kind: "handler" | "tool";
  /** Which cell the callable lives on. `result` shadows `input` on a name
   * collision, matching `cf piece call`'s resolution order. */
  on: "result" | "input";
  /** The verb's input schema — the same schema `call <verb> --help --json`
   * serves. `true` means unconstrained. */
  inputSchema: JSONSchema | true;
  /** Tools only, until handlers gain declared results (verb contract WS-C). */
  outputSchema?: JSONSchema;
}

/**
 * Enumerate every callable a piece exposes (verb contract: Verb discovery,
 * docs/plans/pattern-verb-contract.md). Everything in the durable schema is
 * listed — hiding is a display default that arrives with the wrapper-tier
 * marker, never a capability boundary; until the marker exists, the list IS
 * the full surface. Walks result then input with the same classification
 * `cf piece call` resolves through, so the listing and the dispatcher can
 * never disagree about what is callable.
 */
export async function listPieceCallables(
  config: PieceConfig,
  deps: PieceCallableDependencies = {},
): Promise<PieceCallableListing[]> {
  const { piece } = await loadPieceForCallables(config, deps);

  const listings = new Map<string, PieceCallableListing>();
  // Names ordinary detection rejected: candidates for the forced-stream
  // fallback below, so the listing covers every path `cf piece call` resolves.
  const rejected = new Set<string>();
  let resultRoot: any;
  for (const cellProp of ["result", "input"] as const) {
    const rootCell = await piece[cellProp].getCell();
    if (cellProp === "result") resultRoot = rootCell;
    const value = rootCell.get?.();
    const schema = rootCell.schema;
    const schemaKeys = isRecord(schema) && isRecord(schema.properties)
      ? Object.keys(schema.properties)
      : [];
    const valueKeys = isRecord(value) ? Object.keys(value) : [];
    for (const name of new Set([...valueKeys, ...schemaKeys])) {
      if (listings.has(name)) continue; // result shadows input, like call
      const callableCell = rootCell.key(name).asSchemaFromLinks();
      const kind = detectCallableKind(
        getCallableValue(value, name),
        callableCell,
      );
      if (!kind) {
        rejected.add(name);
        continue;
      }
      rejected.delete(name);
      const spec = callableCommandSpec(callableCell, kind);
      listings.set(name, {
        name,
        kind,
        on: cellProp,
        inputSchema: spec.inputSchema,
        ...(spec.outputSchemaSummary !== undefined
          ? { outputSchema: spec.outputSchemaSummary }
          : {}),
      });
    }
  }

  // Third resolution path, mirrored from resolvePieceCallable: a handler whose
  // schema lost the stream marker still dispatches via the forced stream cast
  // (tryResolvePieceHandler). Probe every rejected name the same way so a
  // callable-by-name verb can never be absent from the listing.
  const pieceCell = typeof piece.getCell === "function"
    ? piece.getCell()
    : undefined;
  if (pieceCell && typeof pieceCell.asSchema === "function") {
    const pieceValue = pieceCell.get?.();
    if (isRecord(pieceValue)) {
      for (const name of Object.keys(pieceValue)) {
        if (!listings.has(name)) rejected.add(name);
      }
    }
    for (const name of rejected) {
      if (listings.has(name)) continue;
      const streamRoot = pieceCell.asSchema({
        type: "object",
        properties: { [name]: { asCell: ["stream"] } },
        required: [name],
      });
      if (!isHandlerCell(streamRoot.key(name))) continue;
      const callableCell = resultRoot.key(name).asSchemaFromLinks();
      const spec = callableCommandSpec(callableCell, "handler");
      listings.set(name, {
        name,
        kind: "handler",
        on: "result",
        inputSchema: spec.inputSchema,
      });
    }
  }

  // Byte-order, not locale collation: this is a machine-readable surface and
  // must sort identically on every host (utf8Compare is the repo comparator).
  return [...listings.values()].sort((a, b) => utf8Compare(a.name, b.name));
}

export async function executePieceCallable(
  config: PieceConfig,
  callableName: string,
  rawArgs: string[],
  deps: PieceCallableDependencies = {},
): Promise<ExecutedPieceCallable> {
  const resolved = await resolvePieceCallable(config, callableName, deps);
  return await executeCallableCommand({
    resolved,
    execution: resolved,
    commandSpec: resolved.commandSpec,
    rawArgs,
    deps,
    renderHelp: (commandSpec, parsed) =>
      parsed.showHelpJson
        ? renderExecHelpJson(commandSpec)
        : renderPieceCallHelp(
          deps.helpCommandPrefix ??
            cliCommand(["piece", "call", "...", callableName]),
          commandSpec,
        ),
  });
}

export async function linkPieces(
  config: SpaceConfig,
  sourcePieceId: string,
  sourcePath: (string | number)[],
  targetPieceId: string,
  targetPath: (string | number)[],
  options?: {
    start?: boolean;
    allowNonExisting?: boolean;
    sourceScope?: PieceConfig["pieceScope"];
    targetScope?: PieceConfig["pieceScope"];
  },
): Promise<void> {
  const manager = await timeCliPhase(
    "linkPieces.loadManager",
    () => loadManager(config),
  );
  const pieces = new PiecesController(manager);
  const resolvedSourcePieceId = await timeCliPhase(
    "linkPieces.resolveSource",
    () =>
      resolveLinkEndpointAddress(manager, sourcePieceId, undefined, {
        allowMissingSlugFallback: true,
      }),
  );
  const resolvedTargetPieceId = await timeCliPhase(
    "linkPieces.resolveTarget",
    () => resolveLinkEndpointAddress(manager, targetPieceId),
  );

  // Validate that source and target pieces/paths exist by reading them
  if (!options?.allowNonExisting) {
    const errors: string[] = [];

    // Check source piece exists by verifying it has a pattern cell
    // (i.e., was created via cf piece new, not just written to with cf piece set)
    const sourcePiece = await timeCliPhase(
      "linkPieces.getSourcePiece",
      () =>
        pieces.get(
          resolvedSourcePieceId,
          false,
          undefined,
          options?.sourceScope,
        ),
    );
    const sourceHasPattern =
      getPatternIdentityRef(sourcePiece.getCell()) !== undefined;
    if (!sourceHasPattern) {
      errors.push(`Source piece ${sourcePieceId} does not have pattern`);
    } else if (sourcePath.length > 0) {
      const sourceData = await timeCliPhase(
        "linkPieces.readSourceResult",
        () => sourcePiece.result.get(),
      );
      // Check source path resolves
      let current: any = sourceData;
      for (const segment of sourcePath) {
        if (current == null || typeof current !== "object") {
          errors.push(
            `Source path "${
              sourcePath.join("/")
            }" does not exist on piece ${sourcePieceId}`,
          );
          break;
        }
        current = current[segment];
      }
      if (current === undefined) {
        errors.push(
          `Source path "${
            sourcePath.join("/")
          }" does not exist on piece ${sourcePieceId}`,
        );
      }
    }

    // Check target piece exists by verifying it has a pattern cell
    const targetPiece = await timeCliPhase(
      "linkPieces.getTargetPiece",
      () =>
        pieces.get(
          resolvedTargetPieceId,
          false,
          undefined,
          options?.targetScope,
        ),
    );
    const targetHasPattern =
      getPatternIdentityRef(targetPiece.getCell()) !== undefined;
    if (!targetHasPattern) {
      errors.push(`Target piece ${targetPieceId} does not have pattern`);
    } else if (targetPath.length > 0) {
      // Check target path resolves on the input cell
      const targetData = await timeCliPhase(
        "linkPieces.readTargetInput",
        () => targetPiece.input.get(),
      );
      let current: any = targetData;
      for (const segment of targetPath) {
        if (current == null || typeof current !== "object") {
          errors.push(
            `Target path "${
              targetPath.join("/")
            }" does not exist on piece ${targetPieceId}`,
          );
          break;
        }
        current = current[segment];
      }
      if (current === undefined) {
        errors.push(
          `Target path "${
            targetPath.join("/")
          }" does not exist on piece ${targetPieceId}`,
        );
      }
    }

    if (errors.length > 0) {
      throw new LinkValidationError(
        errors.join("\n") + "\n\nUse --allow-non-existing to link anyway.",
      );
    }
  }

  await timeCliPhase(
    "linkPieces.manager.link",
    () =>
      manager.link(
        resolvedSourcePieceId,
        sourcePath,
        resolvedTargetPieceId,
        targetPath,
        options,
      ),
  );
}

/**
 * Phase 7: link a pattern field to an injected on-disk SQLite source
 * (`cf piece link sqlite:<absPath> <piece>/<field>`, read-only v1). Derives a
 * stable handle id from (space, absPath), creates the handle cell at that id with
 * value `{ id, tables: {}, rev: 0 }`, registers the on-disk source with the server
 * (so reads attach the file read-only for that id), then links the handle into
 * the target field. Idempotent: re-linking the same path resolves to the same
 * handle id (same cell, same registration). v1 is read-only — `db.exec` against an
 * injected source is rejected by the server (Q13/Q14).
 */
export async function linkSqliteDiskSource(
  config: SpaceConfig,
  absPath: string,
  targetPieceId: string,
  targetPath: (string | number)[],
  options?: { start?: boolean; targetScope?: CellScope },
): Promise<void> {
  const manager = await loadManager(config);
  const space = manager.getSpace();
  const id = deriveDiskHandleId(space, absPath);

  // 1. Seed the handle cell AT the deterministic id. Its entity id == its
  //    value.id == the server registry key, so a pattern read of the linked
  //    handle resolves to the id the server holds a disk descriptor for. tables
  //    is empty — v1 does not migrate external files (the on-disk db owns its
  //    schema); the server skips ensureTables for a registered source.
  const handle = manager.runtime.getCellFromEntityId(
    space,
    entityIdFrom(id),
    [],
    undefined,
  );
  const writeRes = await manager.runtime.editWithRetry((tx) => {
    handle.withTx(tx).set({ id, tables: {}, rev: 0 });
  });
  if (writeRes.error) throw writeRes.error;

  // 2. Register the on-disk source with the server (read-only attach for `id`).
  const provider = manager.runtime.storageManager.open(space);
  if (!provider.registerSqliteDiskSource) {
    throw new Error(
      "storage provider does not support injected sqlite disk sources",
    );
  }
  await provider.registerSqliteDiskSource(id, absPath);

  // 3. Link the handle (addressed by entity id) into the target field.
  const resolvedTarget = await resolveLinkEndpointAddress(
    manager,
    targetPieceId,
  );
  await manager.link(id, [], resolvedTarget, targetPath, {
    start: options?.start,
    targetScope: options?.targetScope,
  });
  await manager.synced();
}

export class LinkValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LinkValidationError";
  }
}

// Constants for piece mapping
const SHORT_ID_LENGTH = 8;

// Types for piece mapping
export interface PieceConnection {
  name: string;
  readingFrom: string[];
  readBy: string[];
}

export type PieceConnectionMap = Map<string, PieceConnection>;

// Helper functions for piece mapping
function createShortId(id: string): string {
  if (id.length <= SHORT_ID_LENGTH * 2 + 3) {
    return id; // Don't truncate if it's already short enough
  }
  const start = id.slice(0, SHORT_ID_LENGTH);
  const end = id.slice(-SHORT_ID_LENGTH);
  return `${start}...${end}`;
}

function createPieceConnection(
  piece: { id: string; name?: string },
  details?: {
    name?: string;
    readingFrom: Array<{ id: string }>;
    readBy: Array<{ id: string }>;
  },
): PieceConnection {
  return {
    name: details?.name || piece.name || createShortId(piece.id),
    readingFrom: details?.readingFrom.map((c) => c.id) || [],
    readBy: details?.readBy.map((c) => c.id) || [],
  };
}

async function buildConnectionMap(
  config: SpaceConfig,
): Promise<PieceConnectionMap> {
  const pieces = await listPieces(config);
  const connections: PieceConnectionMap = new Map();

  for (const piece of pieces) {
    const pieceConfig: PieceConfig = { ...config, piece: piece.id };
    try {
      const details = await inspectPiece(pieceConfig);
      connections.set(piece.id, createPieceConnection(piece, details));
    } catch (error) {
      // Skip pieces that can't be inspected, but include them with no connections
      console.error(
        `Warning: Could not inspect piece ${piece.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      connections.set(piece.id, createPieceConnection(piece));
    }
  }

  return connections;
}

function generateAsciiMap(connections: PieceConnectionMap): string {
  if (connections.size === 0) {
    return "No pieces found in space.";
  }

  let output = "=== Piece Space Map ===\n\n";

  // Sort pieces by connection count for better visualization
  const sortedPieces = Array.from(connections.entries()).sort(
    ([, a], [, b]) =>
      b.readingFrom.length +
      b.readBy.length -
      (a.readingFrom.length + a.readBy.length),
  );

  for (const [id, info] of sortedPieces) {
    const shortId = createShortId(id);
    output += `📦 ${info.name} [${shortId}]\n`;

    if (info.readingFrom.length > 0) {
      output += "  ← reads from:\n";
      for (const sourceId of info.readingFrom) {
        const sourceName = connections.get(sourceId)?.name ||
          createShortId(sourceId);
        output += `    • ${sourceName}\n`;
      }
    }

    if (info.readBy.length > 0) {
      output += "  → read by:\n";
      for (const targetId of info.readBy) {
        const targetName = connections.get(targetId)?.name ||
          createShortId(targetId);
        output += `    • ${targetName}\n`;
      }
    }

    if (info.readingFrom.length === 0 && info.readBy.length === 0) {
      output += "  (no connections)\n";
    }

    output += "\n";
  }

  return output;
}

function generateDotMap(connections: PieceConnectionMap): string {
  let dot = "digraph PieceSpace {\n";
  dot += "  rankdir=LR;\n";
  dot += "  node [shape=box];\n\n";

  // Add nodes
  for (const [id, info] of connections) {
    const shortId = createShortId(id);
    dot += `  "${id}" [label="${info.name}\\n${shortId}"];\n`;
  }
  dot += "\n";

  // Add edges
  for (const [id, info] of connections) {
    for (const targetId of info.readingFrom) {
      dot += `  "${targetId}" -> "${id}";\n`;
    }
  }

  dot += "}";
  return dot;
}

export enum MapFormat {
  ASCII = "ascii",
  DOT = "dot",
}

export function formatSpaceMap(
  connections: PieceConnectionMap,
  format: MapFormat,
): string {
  switch (format) {
    case MapFormat.ASCII:
      return generateAsciiMap(connections);
    case MapFormat.DOT:
      return generateDotMap(connections);
    default:
      throw new Error(`Unsupported format: ${format}`);
  }
}

export async function generateSpaceMap(
  config: SpaceConfig,
  format: MapFormat = MapFormat.ASCII,
): Promise<string> {
  const connections = await buildConnectionMap(config);
  return formatSpaceMap(connections, format);
}

export async function inspectPiece(
  config: PieceConfig,
  deps: PieceOperationDependencies = {},
): Promise<{
  id: string;
  name?: string;
  patternRef?: PiecePatternRef;
  source?: Readonly<unknown>;
  result: Readonly<unknown>;
  readingFrom: Array<{ id: string; name?: string }>;
  readBy: Array<{ id: string; name?: string }>;
}> {
  const manager = await (deps.loadManager ?? loadManager)(config);
  let resolvedConfig: PieceConfig;
  try {
    resolvedConfig = await resolvePieceConfigWithManager(
      config,
      manager,
      deps.resolvePieceAddress,
    );
  } catch (error) {
    if (
      error instanceof SlugResolutionError &&
      error.code === "not-piece"
    ) {
      return await inspectSlugTargetCell(manager, config.piece);
    }
    throw error;
  }
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );

  const id = piece.id;
  const name = piece.name();
  const patternRef = await piece.getPatternRef();
  const source = (await piece.input.get()) as Readonly<unknown>;
  const result = (await piece.result.get()) as Readonly<unknown>;
  const readingFrom = (await piece.readingFrom()).map((piece) => ({
    id: piece.id,
    name: piece.name(),
  }));
  const readBy = (await piece.readBy()).map((piece) => ({
    id: piece.id,
    name: piece.name(),
  }));

  return {
    id,
    name,
    patternRef,
    source,
    result,
    readingFrom,
    readBy,
  };
}

async function inspectSlugTargetCell(
  manager: PieceManager,
  slug: string,
): Promise<{
  id: string;
  name?: string;
  patternRef?: PiecePatternRef;
  source?: Readonly<unknown>;
  result: Readonly<unknown>;
  readingFrom: Array<{ id: string; name?: string }>;
  readBy: Array<{ id: string; name?: string }>;
}> {
  const target = await resolveSlugTargetCell(manager, slug);
  await target.pull();
  const result = target.get() as Readonly<unknown>;
  const name = isRecord(result) && typeof result[NAME] === "string"
    ? result[NAME]
    : undefined;
  const identityRef = getPatternIdentityRef(target);
  const patternRef: PiecePatternRef | undefined = identityRef === undefined
    ? undefined
    : {
      ...identityRef,
      source: {
        ref: formatFabricRef({
          ref: {
            kind: "uri",
            scheme: "pattern",
            hash: identityRef.identity,
          },
        }),
      },
    };

  return {
    id: slug,
    name,
    patternRef,
    result,
    readingFrom: [],
    readBy: [],
  };
}

export async function getPieceView(config: PieceConfig): Promise<unknown> {
  const data = (await inspectPiece(config)) as any;
  return data.result?.[UI] as VNode;
}

export function formatViewTree(view: unknown): string {
  const format = (node: unknown, prefix: string, last: boolean): string => {
    const branch = last ? "└─ " : "├─ ";
    if (!isVNodeLike(node)) {
      return `${prefix}${branch}${String(node)}`;
    }

    const children = Array.isArray(node.children) ? node.children : [];
    let output = `${prefix}${branch}${node.name}`;
    const nextPrefix = prefix + (last ? "   " : "│  ");
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      const isLast = i === children.length - 1;
      output += "\n" + format(child, nextPrefix, isLast);
    }
    return output;
  };

  return format(view, "", true);
}

export async function getCellValue(
  config: PieceConfig,
  path: (string | number)[],
  options: GetCellValueOptions = {},
  deps: PieceOperationDependencies = {},
): Promise<unknown> {
  const manager = await (deps.loadManager ?? loadManager)(config);
  const resolvedConfig = await resolvePieceConfigWithManager(
    config,
    manager,
    deps.resolvePieceAddress,
  );
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);
  const shouldStep = options.step === true;
  const piece = await pieces.get(
    resolvedConfig.piece,
    shouldStep,
    undefined,
    resolvedConfig.pieceScope,
  );

  try {
    if (shouldStep) {
      await piece.getCell().pull();
      const rootCell =
        await (options.input ? piece.input.getCell() : piece.result.getCell());
      let targetCell = rootCell;
      for (const segment of path) {
        targetCell = targetCell.key(segment as keyof unknown) as Cell<unknown>;
      }
      await targetCell.pull();
      await manager.synced();
      await manager.runtime.idle();
      await manager.synced();
    }

    let value: unknown;
    try {
      value = options.input
        ? await piece.input.get(path)
        : await piece.result.get(path);
    } catch (error) {
      if (
        !options.input && error instanceof Error &&
        error.message.startsWith("Cannot access path") &&
        await resultProjectionFailedAtPath(piece, path)
      ) {
        throw new PieceResultProjectionError(path, shouldStep);
      }
      throw error;
    }

    if (
      !options.input && value === undefined &&
      await resultProjectionFailedAtPath(piece, path)
    ) {
      throw new PieceResultProjectionError(path, shouldStep);
    }

    return value;
  } finally {
    if (shouldStep) {
      await pieces.stop(resolvedConfig.piece);
    }
  }
}

export async function setCellValue(
  config: PieceConfig,
  path: (string | number)[],
  value: unknown,
  options?: { input?: boolean },
): Promise<void> {
  const manager = await loadManager(config);
  const resolvedConfig = await resolvePieceConfigWithManager(config, manager);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  if (options?.input) {
    await piece.input.set(value, path);
  } else {
    await piece.result.set(value, path);
  }
}

/**
 * Calls a named handler within a piece with a decoded JSON payload.
 */
export async function callPieceHandler<T = any>(
  config: PieceConfig,
  handlerName: string,
  args: T,
): Promise<void> {
  const resolved = await timeCliPhase(
    "callPieceHandler.resolve",
    () => resolvePieceCallable(config, handlerName),
  );
  if (resolved.callableKind !== "handler") {
    throw new Error(`Callable "${handlerName}" is not a handler`);
  }
  await timeCliPhase(
    "callPieceHandler.execute",
    () => executeResolvedCallable(resolved, args),
  );
}

export async function stepPiece(config: PieceConfig): Promise<void> {
  const manager = await timeCliPhase(
    "stepPiece.loadManager",
    () => loadManager(config),
  );
  const resolvedConfig = await resolvePieceConfigWithManager(config, manager);
  const pieces = new PiecesController(manager);
  const piece = await timeCliPhase(
    "stepPiece.getPiece",
    () =>
      pieces.get(
        resolvedConfig.piece,
        true,
        undefined,
        resolvedConfig.pieceScope,
      ),
  );
  await timeCliPhase("stepPiece.pull", () => piece.getCell().pull());
  await timeCliPhase("stepPiece.manager.synced", () => manager.synced());
  await timeCliPhase("stepPiece.stop", () => pieces.stop(resolvedConfig.piece));
}

/**
 * Removes a piece from the space.
 */
export async function removePiece(config: PieceConfig): Promise<void> {
  const manager = await loadManager(config);
  const resolvedConfig = await resolvePieceConfigWithManager(config, manager);
  const pieces = new PiecesController(manager);
  const removed = await pieces.remove(resolvedConfig.piece);

  if (!removed) {
    throw new Error(`Piece "${config.piece}" not found`);
  }
}

interface RootPatternController {
  recreateDefaultPattern(): Promise<{ id: string }>;
}

interface RootPatternDeps {
  loadManager?: typeof loadManager;
  createController?: (manager: PieceManager) => RootPatternController;
}

/**
 * Recreate the default/root pattern for an explicitly targeted space.
 */
export async function recreateSpaceRootPattern(
  config: SpaceConfig,
  deps: RootPatternDeps = {},
): Promise<string> {
  const manager = await (deps.loadManager ?? loadManager)(config);
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);
  const piece = await pieces.recreateDefaultPattern();
  return piece.id;
}

function isVNodeLike(value: unknown): value is VNode {
  const visited = new Set<object>();
  while (isRecord(value) && UI in value) {
    if (visited.has(value)) return false; // Cycle detected
    visited.add(value);
    value = value[UI];
  }
  return (value as VNode)?.type === "vnode";
}

/**
 * Deploy a custom home pattern from a local file.
 * Automatically targets the home space (user's identity DID).
 */
export async function setHomePattern(
  config: Omit<SpaceConfig, "space">,
  entry: EntryConfig,
  deps: PieceOperationDependencies = {},
): Promise<void> {
  const identity = await (deps.loadIdentity ?? loadIdentity)(config.identity);
  const homeConfig: SpaceConfig = { ...config, space: identity.did() };
  const manager = await (deps.loadManager ?? loadManager)(homeConfig);
  const program = await (deps.getProgramFromFile ?? getProgramFromFile)(
    manager,
    entry,
  );
  const pieces = deps.createController?.(manager) ??
    new PiecesController(manager);
  await pieces.recreateDefaultPattern({
    customProgram: program,
    repository: entry.repository,
  });
}

/**
 * Reset the home pattern to the system default.
 */
export async function resetHomePattern(
  config: Omit<SpaceConfig, "space">,
): Promise<void> {
  const identity = await loadIdentity(config.identity);
  const homeConfig: SpaceConfig = { ...config, space: identity.did() };
  const manager = await loadManager(homeConfig);
  const pieces = new PiecesController(manager);
  await pieces.recreateDefaultPattern();
}
