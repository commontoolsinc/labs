import { createSession, isDID, Session } from "@commonfabric/identity";
import { ensureDir } from "@std/fs";
import { caseFold } from "unicode-case-folding";
import { loadIdentity } from "./identity.ts";
import {
  Cell,
  deepEqual,
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
  type MemorySpace,
  NAME,
  Runtime,
  runtimePresets,
  RuntimeProgram,
  UI,
  VNode,
} from "@commonfabric/runner";
import {
  type CfcLabelView,
  cfcLabelViewForCellWithStatus,
  cfcLabelViewFromSchema,
  getCarriedCfcLabelView,
  type IFCLabel,
  mergeCfcLabelViews,
  redactCaveatSourcesForDisplay,
  validateSchemaValue,
} from "@commonfabric/runner/cfc";
import type { CellScope, JSONSchema } from "@commonfabric/api";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import {
  assignSlug,
  pieceId,
  resolvePieceAddress as resolveStoredPieceAddress,
  resolveSlugTargetCell,
  setSlugLink,
  SlugResolutionError,
} from "@commonfabric/piece";
import {
  type PatternCompatibilityReport,
  type PiecePatternRef,
  PiecesController,
} from "@commonfabric/piece/ops";
import { common, dirname, join } from "@std/path";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { setLLMUrl } from "@commonfabric/llm";
import {
  FabricPrimitive,
  FabricSpecialObject,
} from "@commonfabric/data-model/fabric-value";
import { codecOf } from "@commonfabric/data-model/codec-common";
import { hashStringOf } from "@commonfabric/data-model/value-hash";
import { isArrayIndexPropertyName } from "@commonfabric/utils/arrays";
import { isObjectOrArray, isPlainObject } from "@commonfabric/utils/types";
import { pinProgramFabricImports, renderPinRewrite } from "./fabric-deps.ts";
import { isHandlerCell, isStreamValue } from "../../fuse/callables.ts";
import { throwOnSpaceAuthorizationError } from "./utils.ts";
import {
  callableCommandSpec,
  type CallableExecutionDeps,
  type CallableResolution,
  type CallableResultRef,
  CF_RUNTIME_ERROR_LOG,
  type CliRuntimeErrorRecord,
  detectCallableKind,
  executeResolvedCallable,
  type InvocationOutcome,
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
import { startVersionCheck } from "./version-check.ts";
import { stderrConsoleHandler } from "./json-output.ts";
import {
  type CellSelection,
  CellSelectionError,
  deriveSelectedValue,
} from "./cell-selection.ts";
import { validateEmbeddedSpaces } from "./llm-friendly-ref.ts";

export interface EntryConfig {
  mainPath: string;
  mainExport?: string;
  repository?: string;
  rootPath?: string;
  /** Test entry paths whose resolved source closures travel with the piece. */
  testPaths?: string[];
}

export interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
  jsonOutput?: boolean;
  deferSpaceCellSync?: boolean;
  /**
   * Space DIDs embedded in LLM-friendly references given to this command,
   * carried here when `space` is a name rather than a DID. A name only
   * resolves to a DID once the session opens, so `loadPieces` checks each
   * of these against the session's resolved space DID.
   */
  embeddedSpaces?: string[];
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
  /**
   * Path segments embedded in an LLM-friendly `--piece` reference. A command
   * that reads or writes at a path prepends these to its positional path
   * argument; a command whose intake is id-only rejects a reference that
   * carries them.
   */
  piecePath?: (string | number)[];
}

export interface SetPiecePatternOptions {
  dangerouslyAllowIncompatibleSchema?: boolean;
}

export interface GetCellValueOptions {
  input?: boolean;
  step?: boolean;
  selection?: CellSelection;
}

/** A declared CFC label update accepted by `cf piece set-label`. */
export type CellCfcLabelUpdate = IFCLabel & {
  observes?: LabelObservationClass;
};

type LabelObservationClass = NonNullable<
  CfcLabelView["entries"][number]["observes"]
>;

const CFC_LABEL_OBSERVATION_CLASSES = new Set<LabelObservationClass>([
  "value",
  "shape",
  "enumerate",
  "followRef",
]);

/**
 * Validate the JSON object accepted by `cf piece set-label`.
 *
 * The command exposes the two stored label families and their observation
 * class. Policy claims such as `requiredIntegrity` remain pattern-schema
 * authoring concerns rather than label metadata.
 */
export function parseCellCfcLabelUpdate(
  input: unknown,
): CellCfcLabelUpdate {
  if (!isPlainObject(input)) {
    throw new Error("CFC label input must be a JSON object.");
  }

  const supported = new Set(["confidentiality", "integrity", "observes"]);
  const unsupported = Object.keys(input).filter((key) => !supported.has(key));
  if (unsupported.length > 0) {
    throw new Error(
      `Unknown CFC label field${unsupported.length === 1 ? "" : "s"}: ` +
        unsupported.join(", ") +
        ". Expected confidentiality, integrity, or observes.",
    );
  }

  const confidentiality = input.confidentiality;
  const integrity = input.integrity;
  if (confidentiality === undefined && integrity === undefined) {
    throw new Error(
      "CFC label input must include confidentiality or integrity.",
    );
  }
  if (confidentiality !== undefined && !Array.isArray(confidentiality)) {
    throw new Error("CFC label confidentiality must be a JSON array.");
  }
  if (integrity !== undefined && !Array.isArray(integrity)) {
    throw new Error("CFC label integrity must be a JSON array.");
  }

  const observes = input.observes;
  if (
    observes !== undefined &&
    !CFC_LABEL_OBSERVATION_CLASSES.has(
      observes as LabelObservationClass,
    )
  ) {
    throw new Error(
      "CFC label observes must be value, shape, enumerate, or followRef.",
    );
  }

  return {
    ...(confidentiality !== undefined
      ? { confidentiality: [...confidentiality] }
      : {}),
    ...(integrity !== undefined ? { integrity: [...integrity] } : {}),
    ...(observes !== undefined
      ? { observes: observes as LabelObservationClass }
      : {}),
  } as CellCfcLabelUpdate;
}

function cfcLabelViewForCommand(
  cell: unknown,
  path: readonly (string | number)[],
): CfcLabelView | null {
  const { view, readFailed } = cfcLabelViewForCellWithStatus(cell);
  if (readFailed) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(`Could not read CFC labels at "${location}".`);
  }
  const schema = isObjectOrArray(cell)
    ? cell.schema as JSONSchema | undefined
    : undefined;
  const effectiveView = mergeCfcLabelViews([
    view,
    cfcLabelViewFromSchema(schema),
  ]);
  return effectiveView === undefined
    ? null
    : redactCaveatSourcesForDisplay(effectiveView);
}

/** A `cf piece get` path that lands ON a verb. Reading a verb returns the
 * stream's serialization — never what the caller wanted — so the read refuses
 * and redirects instead, mirroring the llm-dialog read tool's "Path resolves
 * to a handler; use invoke() instead." (verb contract WS-F, read-path guard).
 * `callable` is whether `cf piece call <verb>` actually resolves the verb —
 * the dispatcher resolves root-level names only — so the refusal never
 * suggests a command that would fail: a nested verb points at reading the
 * parent object or the root-level verbs listing instead. */
export class PieceVerbReadError extends Error {
  constructor(verb: string, piece: string, callable: boolean) {
    super(
      callable
        ? `Path resolves to a verb; use 'cf piece call --piece ${piece} ${verb}' instead.`
        : `Path resolves to a verb that is not directly callable: verbs are ` +
          `invoked at the piece's root surface. Read the parent object ` +
          `instead, or list the callable verbs with ` +
          `'cf piece verbs --piece ${piece}'.`,
    );
    this.name = "PieceVerbReadError";
  }
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

/**
 * A resolved piece callable: the shared resolution plus the command spec its
 * flags and help page are built from.
 *
 * `declaredResult` (on {@link CallableResolution}) is attached here for a
 * handler exposed on the piece's result cell, which is the only place a
 * declared result can be matched from; a tool's result schema already rides
 * its callable cell and reaches `commandSpec` directly.
 */
export interface ResolvedPieceCallable extends CallableResolution {
  commandSpec: ExecCommandSpec;
}

export interface PieceCallableDependencies extends CallableExecutionDeps {
  helpCommandPrefix?: string;
  loadPieces?: (config: SpaceConfig) => Promise<any>;
  loadPiece?: (
    pieces: any,
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
  /** Handler invocation outcome, passed through from ExecutedCallable. */
  invocation?: InvocationOutcome;
  /** Tool result cell address, passed through from ExecutedCallable. */
  resultRef?: CallableResultRef;
  parsed: ParsedExecArgs;
  resolved: ResolvedPieceCallable;
}

export interface PieceResolutionDeps {
  loadPieces?: typeof loadPieces;
  resolvePieceAddress?: (
    pieces: PiecesController,
    token: string,
  ) => Promise<string>;
}

interface PieceOperationDependencies extends PieceResolutionDeps {
  loadIdentity?: typeof loadIdentity;
  getProgramFromFile?: typeof getProgramFromFile;
  getPinnedProgramFromFile?: typeof getPinnedProgramFromFile;
  reportSearchError?: (
    pieceId: string,
    source: "input data" | "result data" | "metadata",
    error: unknown,
  ) => void;
  deriveSelectedValue?: typeof deriveSelectedValue;
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
          `loadPieces storage cleanup failed: ${
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
          `loadPieces cleanup failed: ${
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

export async function loadPieces(
  config: SpaceConfig,
): Promise<PiecesController> {
  setLLMUrl(config.apiUrl);
  const session = await timeCliPhase(
    "loadPieces.makeSession",
    () => makeSession(config),
  );
  // A `--space` given as a name has only now resolved to a DID; this is the
  // deferred half of the embedded-space check `normalizeLLMFriendlyRef`
  // performs at parse time for a DID-configured space.
  validateEmbeddedSpaces(config.embeddedSpaces, session.space);
  // Use a const ref object so we can assign later while keeping const binding
  const piecesRef: { current?: PiecesController } = {};
  const runtimeErrors: CliRuntimeErrorRecord[] = [];
  const runtime = await timeCliPhase(
    "loadPieces.runtime",
    () =>
      // Shared first-party posture for client runtimes against a deployed
      // API (CT-1814); collectors and the navigate hook are this CLI's
      // declared deltas.
      new Runtime({
        ...runtimePresets.remoteClient({
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
              (config.jsonOutput ? console.error : console.log)(
                `navigateTo new piece id ${id}`,
              );
              // Best-effort: ensure piece is present in list
              runtime.storageManager
                .synced()
                .then(async () => {
                  try {
                    const mgr = piecesRef.current!;
                    const piecesCell = await mgr.getPieceRegistry();
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
        }),
        ...(config.jsonOutput ? { consoleHandler: stderrConsoleHandler } : {}),
      }),
  );
  (runtime as Runtime & { [CF_RUNTIME_ERROR_LOG]?: CliRuntimeErrorRecord[] })[
    CF_RUNTIME_ERROR_LOG
  ] = runtimeErrors;

  return await withRuntimeCleanupOnFailure(runtime, async () => {
    // The server's commit rides the health response the check below already
    // fetches; only cf's own local resolution (baked metadata or git) runs
    // concurrently here, and finish() settles it on both paths so no
    // subprocess op outlives a thrown error.
    const versionCheck = startVersionCheck();
    const healthy = await timeCliPhase(
      "loadPieces.healthCheck",
      () => runtime.healthCheck(),
    );
    await versionCheck.finish(runtime.serverGitSha, config.apiUrl);
    if (!healthy) {
      throw new Error(`Could not connect to "${config.apiUrl.toString()}".`);
    }

    const pieces = await timeCliPhase(
      "loadPieces.controller",
      () =>
        new PiecesController(session, runtime, {
          deferSpaceCellSync: config.deferSpaceCellSync,
        }),
    );
    piecesRef.current = pieces;
    if (config.deferSpaceCellSync) {
      await timeCliPhase(
        "loadPieces.ensureSpaceSession",
        () => pieces.ensureSpaceSession(),
      );
    } else {
      // `synced()` settles even when this space is permanently denied: the
      // memory client terminates a denied session rather than retrying its
      // reopen. It settles quietly, though — a denied cross-space link stays a
      // silent absent read — so surface a denial on THIS space deliberately,
      // with the server's real AuthorizationError.
      await timeCliPhase(
        "loadPieces.synced",
        () => pieces.synced(),
      );
    }
    throwOnSpaceAuthorizationError(runtime.storageManager, session.space);
    return pieces;
  });
}

export async function getProgramFromFile(
  pieces: PiecesController,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  const entryPaths = [entry.mainPath, ...(entry.testPaths ?? [])];
  const rootPath = entry.rootPath ??
    join(common(entryPaths.map((path) => dirname(path))), ".");
  const programs: RuntimeProgram[] = await Promise.all(
    entryPaths.map((path) =>
      pieces.runtime.harness.resolve(
        new FileSystemProgramResolver(path, rootPath),
      )
    ),
  );
  const [mainProgram, ...testPrograms] = programs;
  const files = new Map<string, RuntimeProgram["files"][number]>();
  for (const program of [mainProgram, ...testPrograms]) {
    for (const file of program.files) {
      const existing = files.get(file.name);
      if (existing !== undefined && existing.contents !== file.contents) {
        throw new Error(
          `Source package contains conflicting files named "${file.name}".`,
        );
      }
      files.set(file.name, file);
    }
  }
  const program: RuntimeProgram = {
    main: mainProgram.main,
    files: [...files.values()],
    ...(testPrograms.length === 0
      ? {}
      : { sourceRoots: testPrograms.map((test) => test.main) }),
  };
  if (entry.mainExport) {
    program.mainExport = entry.mainExport;
  }
  return program;
}

async function getPinnedProgramFromFile(
  pieces: PiecesController,
  entry: EntryConfig,
): Promise<RuntimeProgram> {
  const program = await getProgramFromFile(pieces, entry);
  const result = await pinProgramFabricImports(
    pieces.runtime,
    pieces.getSpace(),
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
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const registeredPieces = await pieces.getRegisteredPieces();
  return Promise.all(
    registeredPieces.map(async (piece) => {
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
      // These representations exist to be searched as TEXT, and what a codec
      // produces is largely not that: a `FabricEpochNsec` encodes to a
      // base64url string, which matches nothing anyone would type. Nor are a
      // `FabricInstance`'s contents reached -- this stops at the object rather
      // than descending it, so a searchable value nested inside one is
      // invisible. `String(current)` is the only part here doing honest work.
      //
      // TODO(danfuzz): vet this branch for correctness once `data-model`
      // supports walking a `FabricInstance`, at which point its contents can
      // be searched as the values they are rather than as an encoded blob.
      const representations: SearchEntry[] = [];
      if (current.toString !== Object.prototype.toString) {
        try {
          representations.push({ value: String(current) });
        } catch (error) {
          reportReadError?.(error);
        }
      }
      try {
        // A `FabricPrimitive` binds no `[CODEC]`, and its per-format codec
        // would only yield the unsearchable text described above, so it
        // contributes nothing here. For anything else, a missing codec is a
        // real fault and `codecOf()` throws, which the `catch` reports.
        if (!(current instanceof FabricPrimitive)) {
          representations.push({ value: codecOf(current).encode(current) });
        }
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
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const registeredPieces = await pieces.getRegisteredPieces();
  const registeredPieceIds = new Set(
    registeredPieces.map((piece) => piece.id),
  );
  const ownerCache: PieceOwnerCache = {
    cells: new Map(),
    documents: new Map(),
  };
  const matches: Array<PieceSearchResult | undefined> = new Array(
    registeredPieces.length,
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
    while (nextPieceIndex < registeredPieces.length) {
      const index = nextPieceIndex++;
      const piece = registeredPieces[index];

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
      {
        length: Math.min(
          PIECE_SEARCH_CONCURRENCY,
          registeredPieces.length,
        ),
      },
      searchNextPiece,
    ),
  );

  return matches.filter((piece): piece is PieceSearchResult =>
    piece !== undefined
  );
}

async function resolvePieceConfigWithPieces(
  config: PieceConfig,
  pieces: PiecesController,
  resolver: PieceResolutionDeps["resolvePieceAddress"] =
    resolveStoredPieceAddress,
): Promise<PieceConfig> {
  return {
    ...config,
    piece: await resolver(pieces, config.piece),
  };
}

export async function resolvePieceConfig(
  config: PieceConfig,
  deps: PieceResolutionDeps = {},
): Promise<PieceConfig> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  return await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps.resolvePieceAddress,
  );
}

export async function resolveLinkEndpointAddress(
  pieces: PiecesController,
  token: string,
  resolver: PieceResolutionDeps["resolvePieceAddress"] =
    resolveStoredPieceAddress,
  options?: { allowMissingSlugFallback?: boolean },
): Promise<string> {
  try {
    return await resolver(pieces, token);
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
  const pieces = await timeCliPhase(
    "newPiece.loadPieces",
    () => (deps.loadPieces ?? loadPieces)(config),
  );

  // The default pattern is a hard requirement for this command: even when the
  // user's pattern doesn't use it, registration below (pieces.add) sends an
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
        pieces,
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
  const runtimeErrors = runtimeErrorLog(pieces.runtime);
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
      () => assignSlug(pieces, piece.getCell(), options.slug!),
    );
  }

  // Explicitly add the piece to the space's registry.
  await timeCliPhase(
    "newPiece.addToDefaultPattern",
    () => pieces.add([piece.getCell()]),
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
  const pieces = await timeCliPhase(
    "setPieceSlug.loadPieces",
    () => loadPieces(config),
  );
  const resolvedSourcePieceId = await timeCliPhase(
    "setPieceSlug.resolveSource",
    () => resolveStoredPieceAddress(pieces, sourcePieceId),
  );
  const source = sourcePath.length === 0
    ? pieces.runtime.getCellFromEntityId(
      pieces.getSpace(),
      entityIdFrom(resolvedSourcePieceId),
      [],
      undefined,
      undefined,
      options?.sourceScope,
    )
    : (await timeCliPhase(
      "setPieceSlug.getSourcePiece",
      () => {
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
      setSlugLink(pieces, slug, source, {
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
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps.resolvePieceAddress,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  await piece.setPattern(
    await (deps.getPinnedProgramFromFile ?? getPinnedProgramFromFile)(
      pieces,
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

/**
 * Would `setPiecePattern` be accepted for this piece? Applies nothing.
 *
 * Same shape as `setPiecePattern` up to the point of the swap, so the verdict
 * is about the source the user would actually apply — including its resolved
 * imports and pinned program — rather than an approximation of it.
 */
export async function checkPiecePattern(
  config: PieceConfig,
  entry: EntryConfig,
  deps: PieceOperationDependencies = {},
): Promise<PatternCompatibilityReport> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps.resolvePieceAddress,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  return await piece.checkPattern(
    await (deps.getPinnedProgramFromFile ?? getPinnedProgramFromFile)(
      pieces,
      entry,
    ),
  );
}

export async function savePiecePattern(
  config: PieceConfig,
  outPath: string,
): Promise<void> {
  await ensureDir(outPath);
  const pieces = await loadPieces(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
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
  const pieces = await loadPieces(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
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
  pieces: any,
  space: MemorySpace,
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
    commandSpec: callableCommandSpec(callableCell, callableKind),
    pieces,
    space,
  };
}

/** The forced-stream cast: assert `name` on `cell` is a stream, then ask the
 * runtime whether it answers as one. The third and last resolution path of
 * `cf piece call` (tryResolvePieceHandler), where a handler whose stored
 * schema lost the stream marker still answers.
 *
 * It proves nothing, and belongs ONLY here. The cast's stream schema survives
 * link resolution for an inline value, so `Cell.isStream`'s schema branch
 * answers from the assertion the caller just made and every name passes.
 * That is acceptable as a dispatcher's last resort — the caller named this
 * verb, and a wrong cast fails harmlessly against a value with no handler
 * behind it. It is not acceptable anywhere that describes what a piece has:
 * the listing and the read-path guard both classify on definite stored
 * signals instead. Returns the cast cell, or null. */
function probeForcedStreamCell(cell: any, name: string): any | null {
  if (
    typeof cell !== "object" || cell === null ||
    typeof cell.asSchema !== "function"
  ) {
    return null;
  }
  const streamRoot = cell.asSchema({
    type: "object",
    properties: {
      [name]: { asCell: ["stream"] },
    },
    required: [name],
  });
  const streamCell = streamRoot.key(name);
  return isHandlerCell(streamCell) ? streamCell : null;
}

async function tryResolvePieceHandler(
  piece: any,
  pieces: any,
  space: MemorySpace,
  callableName: string,
): Promise<ResolvedPieceCallable | null> {
  const pieceCell = piece.getCell?.();
  if (!pieceCell) {
    return null;
  }

  const streamCell = probeForcedStreamCell(pieceCell, callableName);
  if (!streamCell) {
    return null;
  }

  // Dispatch through the cell whose stream-ness this path just proved, not a
  // second cell built by reading the schema back from links. Both address the
  // same target — `getResult` is the identity on the piece cell — so they
  // differ only in schema, and a link-derived schema is exactly what defeated
  // the ordinary detection paths above. Sending on that cell takes `.set()`'s
  // non-stream branch (`packages/runner/src/cell.ts:1316`) and fails with
  // "Transaction required for .set()" instead of queueing the event, so a verb
  // this path lists is a verb that could not be called.
  const rootCell = await piece.result.getCell();
  const linkDerivedCell = rootCell.key(callableName).asSchemaFromLinks();
  return {
    callableCell: streamCell,
    callableKind: "handler",
    cellKey: callableName,
    // The link-derived cell still carries whatever payload schema the piece
    // does publish, which the forced stream cast does not: the command spec
    // reads it for `--help`, and `inputSchema` hands it to the pre-dispatch
    // gate — the cast's own schema admits any payload, so gating on it would
    // dispatch a malformed payload and spend the invocation id.
    commandSpec: callableCommandSpec(linkDerivedCell, "handler"),
    inputSchema: linkDerivedCell.schema,
    pieces,
    space,
  };
}

async function tryResolveLivePieceToolCallable(
  piece: any,
  pieces: any,
  space: MemorySpace,
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
  const tx = pieces.runtime.edit();
  const liveResult = pieces.runtime.getCell(
    space,
    crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
    pieceScope,
  );
  pieces.runtime.run(tx, pattern, input, liveResult);
  pieces.runtime.prepareTxForCommit?.(tx);
  await tx.commit();
  await pieces.runtime.idle();

  const callableCell = liveResult.key(callableName).asSchemaFromLinks();
  const callableKind = detectCallableKind(
    getCallableValue(liveResult.get?.(), callableName),
    callableCell,
  );
  return callableKind === "tool" ? callableCell : null;
}

/** Load the target piece and its pieces controller for callable
 * resolution/listing —
 * one shared path so `cf piece call` and `cf piece verbs` always see the same
 * piece state. */
async function loadPieceForCallables(
  config: PieceConfig,
  deps: PieceCallableDependencies = {},
): Promise<{
  pieces: any;
  piece: any;
  space: MemorySpace;
  resolvedConfig: Awaited<ReturnType<typeof resolvePieceConfigWithPieces>>;
}> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);

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
      pieces,
      resolvedConfig.piece,
      resolvedConfig.pieceScope,
    )
    : pieces.get(
      resolvedConfig.piece,
      true,
      undefined,
      resolvedConfig.pieceScope,
    ));
  const space = pieces.getSpace?.() ?? config.space;
  return { pieces, piece, space, resolvedConfig };
}

async function resolvePieceCallable(
  config: PieceConfig,
  callableName: string,
  deps: PieceCallableDependencies = {},
): Promise<ResolvedPieceCallable> {
  const { pieces, piece, space, resolvedConfig } = await loadPieceForCallables(
    config,
    deps,
  );

  const onResultCell = await tryResolvePieceCallableAt(
    piece,
    pieces,
    space,
    callableName,
    "result",
  );
  // Held apart from the walk only to record WHERE the callable was found: a
  // declared result is keyed by the PATTERN's result properties, so a
  // same-named verb reached on the input cell is a different stream that
  // merely shares its name. The listing draws the same line.
  const onInputCell = onResultCell ? null : await tryResolvePieceCallableAt(
    piece,
    pieces,
    space,
    callableName,
    "input",
  );
  const resolved = onResultCell ?? onInputCell ??
    (await tryResolvePieceHandler(piece, pieces, space, callableName));
  if (!resolved) {
    throw new Error(
      `Callable "${callableName}" not found on piece ${config.piece}`,
    );
  }

  if (
    resolved.callableKind === "handler" && resolved !== onInputCell &&
    typeof piece?.getPattern === "function"
  ) {
    // The forced-stream fallback dispatches on the result cell too, so it
    // claims a declared result on the same terms the ordinary result-cell path
    // does. A piece surface with no pattern to consult carries no thunk at all,
    // which is the honest statement — the absence says this resolution cannot
    // describe a result, rather than promising an answer that is always none.
    return {
      ...resolved,
      declaredResult: () => declaredVerbResult(piece, callableName),
    };
  }

  if (resolved.callableKind === "tool") {
    const liveCallableCell = await tryResolveLivePieceToolCallable(
      piece,
      pieces,
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

/** `cf piece verbs` output: the deployed pattern's source identity plus one
 * row per callable. The identity is the skew detector — a client or skill
 * comparing it against the contract it was written for can tell it targets a
 * newer pattern than the live piece, instead of discovering the mismatch
 * through a silently dropped field (design: Verb discovery). */
export interface PieceCallablesListing {
  /** The deployed pattern's source identity; null when the piece exposes
   * none (e.g. harness doubles). */
  pattern: PiecePatternRef | null;
  verbs: PieceCallableListing[];
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
  /** What the verb hands back: a tool's pattern result schema, a handler's
   * declared result. Absent when the verb declares none — the value-less
   * shape, which is the common one. */
  outputSchema?: JSONSchema;
  /** Listing mark: a UI affordance outside the headless contract (inferred
   * from session-scoped handler bindings at compile time). Hidden from the
   * default listing; always callable. */
  tier?: "wrapper";
  /** Listing mark: `@deprecated` JSDoc on the verb, lowered to the standard
   * schema annotation. Hidden from the default listing; always callable. */
  deprecated?: boolean;
}

/** The default listing's partition: what shows, and what each mark hid.
 * Marked rows keep their marks either way, so `--all` output is
 * self-describing. */
export function partitionVerbListing(
  verbs: readonly PieceCallableListing[],
): { shown: PieceCallableListing[]; wrapper: number; deprecated: number } {
  const shown: PieceCallableListing[] = [];
  let wrapper = 0;
  let deprecated = 0;
  for (const verb of verbs) {
    if (verb.tier === "wrapper") wrapper++;
    else if (verb.deprecated === true) deprecated++;
    else shown.push(verb);
  }
  return { shown, wrapper, deprecated };
}

/** The listing marks as they appear on the durable schema's property. */
function listingMarks(
  rootSchema: unknown,
  name: string,
): { tier?: "wrapper"; deprecated?: boolean } {
  if (!isObjectOrArray(rootSchema) || !isObjectOrArray(rootSchema.properties)) {
    return {};
  }
  const property = (rootSchema.properties as Record<string, unknown>)[name];
  if (!isObjectOrArray(property)) return {};
  return {
    ...(property.tier === "wrapper" ? { tier: "wrapper" as const } : {}),
    ...(property.deprecated === true ? { deprecated: true } : {}),
  };
}

/** Whether two links written in a compiled pattern's own terms address the
 * same cell. An alias's identity is its cause, path and scope; the schema it
 * carries is fidelity for whoever reads through it, and one cell reached from
 * two positions can carry a different one at each. Anything that is not a pair
 * of aliases falls back to whole-link equality, which can only miss — and a
 * miss costs a row its `outputSchema`, never gives it the wrong one. */
function samePatternLink(left: unknown, right: unknown): boolean {
  if (!isObjectOrArray(left) || !isObjectOrArray(right)) return false;
  const leftAlias = left.$alias;
  const rightAlias = right.$alias;
  if (!isObjectOrArray(leftAlias) || !isObjectOrArray(rightAlias)) {
    return deepEqual(left, right);
  }
  return deepEqual(leftAlias.partialCause, rightAlias.partialCause) &&
    deepEqual(leftAlias.path ?? [], rightAlias.path ?? []) &&
    leftAlias.scope === rightAlias.scope;
}

/** A compiled pattern's declared verb results, keyed by the result property
 * each verb is exposed under.
 *
 * A handler node's `$event` input and the result property exposing that
 * handler's stream are one cell written twice in the pattern's own terms, so
 * the property matching a node's `$event` names the verb that node implements
 * — a structural comparison inside one compiled object, with no live cell to
 * resolve. The declared result rides on that node's module, which is where
 * `Stream<E, R>`'s `R` is lowered (verb contract WS-C). A stream two handler
 * nodes share names no single result and so contributes none.
 *
 * A compiled pattern is CALLABLE, so it is not a record and must not be tested
 * as one; only its `result` and `nodes` are read here. */
function declaredVerbResults(
  pattern: { result?: unknown; nodes?: unknown } | null | undefined,
): Map<string, JSONSchema> {
  const declared = new Map<string, JSONSchema>();
  const result = pattern?.result;
  if (!isObjectOrArray(result)) return declared;
  const nodes = Array.isArray(pattern?.nodes) ? pattern.nodes : [];
  for (const [name, link] of Object.entries(result)) {
    let resultSchema: JSONSchema | undefined;
    let matched = 0;
    for (const node of nodes) {
      if (!isObjectOrArray(node) || !isObjectOrArray(node.inputs)) continue;
      if (!samePatternLink(link, node.inputs.$event)) continue;
      matched++;
      const module = node.module;
      if (isObjectOrArray(module) && module.resultSchema !== undefined) {
        resultSchema = module.resultSchema as JSONSchema;
      }
    }
    if (matched === 1 && resultSchema !== undefined) {
      declared.set(name, resultSchema);
    }
  }
  return declared;
}

/** One verb's declared result, matched through the piece's compiled pattern.
 *
 * The same lookup a listing makes for every row, made for a single name — one
 * matcher, so the help page and `cf piece verbs` can never describe the same
 * verb differently. It runs on the help path alone, reached through the thunk
 * on `ResolvedPieceCallable`, which is why loading the pattern is affordable
 * here.
 *
 * The pattern is advisory exactly as it is in the listing: a piece whose
 * pattern will not resolve still calls its verbs, it just cannot say what one
 * hands back. `getPattern` throwing is the whole of that condition here —
 * whether a piece HAS one is settled before the thunk is attached.
 */
async function declaredVerbResult(
  piece: any,
  callableName: string,
): Promise<JSONSchema | undefined> {
  try {
    return declaredVerbResults(await piece.getPattern()).get(callableName);
  } catch {
    return undefined;
  }
}

/**
 * Enumerate every callable a piece exposes (verb contract: Verb discovery,
 * docs/plans/pattern-verb-contract.md). Everything in the durable schema is
 * listed — hiding is a display default driven by the listing marks
 * (`tier: "wrapper"`, `deprecated: true`), never a capability boundary: the
 * rows carry the marks, `partitionVerbListing` decides the default view, and
 * `--all` shows the full surface. Walks result then input with the same classification
 * `cf piece call` resolves through, so the listing and the dispatcher can
 * never disagree about what is callable.
 */
export async function listPieceCallables(
  config: PieceConfig,
  deps: PieceCallableDependencies = {},
): Promise<PieceCallablesListing> {
  const { piece } = await loadPieceForCallables(config, deps);
  let pattern: PiecePatternRef | null = null;
  if (typeof piece.getPatternRef === "function") {
    try {
      pattern = (await piece.getPatternRef()) ?? null;
    } catch {
      pattern = null; // Identity is advisory; the listing itself still holds.
    }
  }

  // A tool's result schema rides its callable cell, but a handler's declared
  // result lives on its node in the compiled graph — so the listing resolves
  // the pattern once and matches nodes to result properties. Resolution is
  // cached by identity, so this costs one load per listing, not one per row.
  let declaredResults = new Map<string, JSONSchema>();
  if (typeof piece.getPattern === "function") {
    try {
      declaredResults = declaredVerbResults(await piece.getPattern());
    } catch {
      // Advisory in the same way the identity above is: a piece with no
      // reachable pattern still lists every verb it exposes.
    }
  }

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
    const schemaKeys =
      isObjectOrArray(schema) && isObjectOrArray(schema.properties)
        ? Object.keys(schema.properties)
        : [];
    const valueKeys = isObjectOrArray(value) ? Object.keys(value) : [];
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
      const marks = listingMarks(schema, name);
      // The declared results are keyed by the PATTERN's result properties, so
      // only a result-cell row can claim one: a same-named verb reached on the
      // input cell is a different stream that merely shares its name.
      const outputSchema = spec.outputSchemaSummary ??
        (cellProp === "result" ? declaredResults.get(name) : undefined);
      listings.set(name, {
        name,
        kind,
        on: cellProp,
        inputSchema: spec.inputSchema,
        ...(outputSchema !== undefined ? { outputSchema } : {}),
        ...marks,
      });
    }
  }

  // Third resolution path, mirrored from resolvePieceCallable: a name the
  // ordinary walk rejected can still be dispatched by name, so it is
  // considered here too.
  //
  // It is classified on the two DEFINITE stored signals the read-path guard
  // uses — a link-derived schema that answers as a stream, or the stored
  // `{$stream: true}` sentinel — and never on the dispatcher's forced-stream
  // cast. That cast asserts what it then asks: its stream schema survives link
  // resolution for an inline value, so `Cell.isStream` answers from the
  // caller's own assertion and EVERY name passes. Harmless in the dispatcher,
  // where a wrong cast fails harmlessly on a call the caller asked for; false
  // in a listing, which is a statement about what exists. A listing that names
  // every data field costs more than one that misses a marker-less handler,
  // because it makes the whole surface untrustworthy — and such a handler
  // stays dispatchable regardless.
  const pieceCell = typeof piece.getCell === "function"
    ? piece.getCell()
    : undefined;
  if (pieceCell) {
    const pieceValue = pieceCell.get?.();
    if (isObjectOrArray(pieceValue)) {
      for (const name of Object.keys(pieceValue)) {
        if (!listings.has(name)) rejected.add(name);
      }
    }
    const resultRootValue = resultRoot?.get?.();
    for (const name of rejected) {
      if (listings.has(name)) continue;
      const callableCell = resultRoot.key(name).asSchemaFromLinks();
      // `rejected` collects names from the result/input walk AND from the
      // piece root's own value, so the sentinel is looked for on both — one
      // cell in a live piece, two objects wherever they are supplied apart.
      const storedValue = getCallableValue(resultRootValue, name) ??
        getCallableValue(pieceValue, name);
      if (!isStreamValue(storedValue) && !isHandlerCell(callableCell)) {
        continue;
      }
      const spec = callableCommandSpec(callableCell, "handler");
      const outputSchema = declaredResults.get(name);
      listings.set(name, {
        name,
        kind: "handler",
        on: "result",
        inputSchema: spec.inputSchema,
        ...(outputSchema !== undefined ? { outputSchema } : {}),
      });
    }
  }

  // Byte-order, not locale collation: this is a machine-readable surface and
  // must sort identically on every host (utf8Compare is the repo comparator).
  return {
    pattern,
    verbs: [...listings.values()].sort((a, b) => utf8Compare(a.name, b.name)),
  };
}

/** The command spec a help page is rendered from: the resolved one, plus the
 * verb's declared result where the resolution can supply one.
 *
 * Only a handler's resolution carries the thunk, so a tool's spec passes
 * through untouched and `callableCommandSpec` keeps deciding what a tool
 * publishes — its result schema rides its callable cell and is already on the
 * spec. */
async function withDeclaredResult(
  spec: ExecCommandSpec,
  resolved: ResolvedPieceCallable,
): Promise<ExecCommandSpec> {
  const declared = await resolved.declaredResult?.();
  return declared === undefined ? spec : {
    ...spec,
    outputSchemaSummary: declared,
  };
}

export async function executePieceCallable(
  config: PieceConfig,
  callableName: string,
  rawArgs: string[],
  deps: PieceCallableDependencies = {},
): Promise<ExecutedPieceCallable> {
  const resolved = await resolvePieceCallable(
    config,
    callableName,
    deps,
  );
  return await executeCallableCommand({
    resolved,
    execution: resolved,
    commandSpec: resolved.commandSpec,
    rawArgs,
    deps,
    renderHelp: async (commandSpec, parsed) => {
      // The declared result is fetched HERE and nowhere earlier: the parse has
      // established that a page is being rendered, so the pattern load it
      // costs is spent on a caller who asked what the verb hands back. Both
      // spellings of the page take it — `--help --json` serves the schema
      // itself as `outputSchema`, the text page enumerates its fields.
      const spec = await withDeclaredResult(commandSpec, resolved);
      return parsed.showHelpJson
        ? renderExecHelpJson(spec)
        : renderPieceCallHelp(
          deps.helpCommandPrefix ??
            cliCommand(["piece", "call", "...", callableName]),
          spec,
        );
    },
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
  const pieces = await timeCliPhase(
    "linkPieces.loadPieces",
    () => loadPieces(config),
  );
  const resolvedSourcePieceId = await timeCliPhase(
    "linkPieces.resolveSource",
    () =>
      resolveLinkEndpointAddress(pieces, sourcePieceId, undefined, {
        allowMissingSlugFallback: true,
      }),
  );
  const resolvedTargetPieceId = await timeCliPhase(
    "linkPieces.resolveTarget",
    () => resolveLinkEndpointAddress(pieces, targetPieceId),
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
    "linkPieces.link",
    () =>
      pieces.link(
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
  const pieces = await loadPieces(config);
  const space = pieces.getSpace();
  const id = deriveDiskHandleId(space, absPath);

  // 1. Seed the handle cell AT the deterministic id. Its entity id == its
  //    value.id == the server registry key, so a pattern read of the linked
  //    handle resolves to the id the server holds a disk descriptor for. tables
  //    is empty — v1 does not migrate external files (the on-disk db owns its
  //    schema); the server skips ensureTables for a registered source.
  const handle = pieces.runtime.getCellFromEntityId(
    space,
    entityIdFrom(id),
    [],
    undefined,
  );
  const writeRes = await pieces.runtime.editWithRetry((tx) => {
    handle.withTx(tx).set({ id, tables: {}, rev: 0 });
  });
  if (writeRes.error) throw writeRes.error;

  // 2. Register the on-disk source with the server (read-only attach for `id`).
  const provider = pieces.runtime.storageManager.open(space);
  if (!provider.registerSqliteDiskSource) {
    throw new Error(
      "storage provider does not support injected sqlite disk sources",
    );
  }
  await provider.registerSqliteDiskSource(id, absPath);

  // 3. Link the handle (addressed by entity id) into the target field.
  const resolvedTarget = await resolveLinkEndpointAddress(
    pieces,
    targetPieceId,
  );
  await pieces.link(id, [], resolvedTarget, targetPath, {
    start: options?.start,
    targetScope: options?.targetScope,
  });
  await pieces.synced();
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
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  let resolvedConfig: PieceConfig;
  try {
    resolvedConfig = await resolvePieceConfigWithPieces(
      config,
      pieces,
      deps.resolvePieceAddress,
    );
  } catch (error) {
    if (
      error instanceof SlugResolutionError &&
      error.code === "not-piece"
    ) {
      return await inspectSlugTargetCell(pieces, config.piece);
    }
    throw error;
  }
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
  pieces: PiecesController,
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
  const target = await resolveSlugTargetCell(pieces, slug);
  await target.pull();
  const result = target.get() as Readonly<unknown>;
  const name = isObjectOrArray(result) && typeof result[NAME] === "string"
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

/** A read path's last segment classified as a verb: the name, and whether
 * `cf piece call <name>` actually resolves it (root-level names only). */
interface ReadPathVerb {
  verb: string;
  callable: boolean;
}

/**
 * Classify a `cf piece get` path whose last segment CERTAINLY lands on a
 * verb. The guard refuses only on the two definite stored signals: the
 * link-derived schema answers as a stream (`isHandlerCell` on the
 * `asSchemaFromLinks` cell — that schema comes from stored links, never from
 * a caller-supplied cast), or the stored value reads as the
 * `{$stream: true}` sentinel. It NEVER refuses on the forced-stream probe:
 * the probe is deliberately permissive for the dispatcher and the listing —
 * over-inclusion there is an extra listing row or a call the caller asked
 * for — but the cast's stream schema survives link resolution for inline
 * values and schema-less links (`resolveLink` keeps the caller's schema and
 * `Cell.isStream`'s schema branch answers from it), so a read guard built on
 * it would refuse plain data outputs. Reads fail open: a classification
 * failure, an uncertain shape, or a tool binding (readable data, exactly as
 * the llm-dialog read tool treats it) all read normally.
 *
 * `callable` is true only for root-level names — the dispatcher's resolution
 * paths all start at a root — so the refusal message can redirect honestly.
 */
async function classifyReadPathVerb(
  piece: any,
  prop: "input" | "result",
  path: readonly (string | number)[],
): Promise<ReadPathVerb | null> {
  const name = path.at(-1);
  // Verbs are named properties; a path-less read is the parent-object read,
  // which stays readable even when the object carries verbs.
  if (typeof name !== "string") return null;
  try {
    const rootCell = await piece[prop].getCell();
    const parentCell = path.length > 1
      ? rootCell.key(...path.slice(0, -1))
      : rootCell;
    const child = parentCell.key(name);
    const derived = child.asSchemaFromLinks?.() ?? child;
    if (
      isStreamValue(getCallableValue(parentCell.get?.(), name)) ||
      isHandlerCell(derived)
    ) {
      return { verb: name, callable: path.length === 1 };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The read-path guard's refusal, preferred over a result-projection failure.
 *
 * A verb is not a materializable result, so a read that lands on one fails the
 * projection check as a matter of course — and that error tells the caller to
 * retry with `--step`, which sends them to re-run a read that cannot succeed
 * at any number of steps. Classify before surrendering to the projection
 * error so the refusal naming `cf piece call` wins. Returns null when the path
 * is not certainly a verb, leaving the projection error exactly as it was.
 */
async function verbReadRefusalOrNull(
  piece: any,
  prop: "input" | "result",
  path: readonly (string | number)[],
  pieceId: string,
): Promise<PieceVerbReadError | null> {
  const verb = await classifyReadPathVerb(piece, prop, path);
  return verb
    ? new PieceVerbReadError(verb.verb, pieceId, verb.callable)
    : null;
}

/**
 * Return the effective CFC label view at one piece data path.
 *
 * Paths in the returned view are relative to the selected cell. The view
 * includes stored declared, derived, and link-carried labels and uses the same
 * display redaction as the runtime-client boundary.
 */
export async function getCellCfcLabel(
  config: PieceConfig,
  path: (string | number)[],
  options: { input?: boolean } = {},
  deps: PieceOperationDependencies = {},
): Promise<CfcLabelView | null> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps.resolvePieceAddress,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const rootCell =
    await (options.input ? piece.input.getCell() : piece.result.getCell());
  const targetCell = rootCell.key(...path);
  await targetCell.pull();
  return cfcLabelViewForCommand(targetCell, path);
}

/**
 * Update the declared CFC label at one piece data path.
 *
 * This updates the label through the same checked write path used by ordinary
 * runtime operations. The stored schema merge and CFC preparation rules
 * therefore reject changes that weaken confidentiality or strengthen
 * integrity. Raw label-map metadata is never written by the CLI.
 */
export async function setCellCfcLabel(
  config: PieceConfig,
  path: (string | number)[],
  input: unknown,
  options: { input?: boolean } = {},
  deps: PieceOperationDependencies = {},
): Promise<CfcLabelView | null> {
  const update = parseCellCfcLabelUpdate(input);
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps.resolvePieceAddress,
  );
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );
  const rootCell =
    await (options.input ? piece.input.getCell() : piece.result.getCell());
  const targetCell = rootCell.key(...path);
  await targetCell.pull();
  const currentView = cfcLabelViewForCommand(targetCell, path);
  const value = targetCell.getRaw();
  if (value === undefined) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(`Cannot set a CFC label on absent path "${location}".`);
  }

  const { observes: requestedObserves, ...label } = update;
  const schemaIfc = isObjectOrArray(targetCell.schema) &&
      isObjectOrArray(targetCell.schema.ifc)
    ? targetCell.schema.ifc
    : undefined;
  const existingObservationClasses = new Set<
    LabelObservationClass | undefined
  >(
    currentView?.entries
      .filter((entry) => entry.path.length === 0)
      .map((entry) => entry.observes) ?? [],
  );
  if (schemaIfc !== undefined) {
    existingObservationClasses.add(
      CFC_LABEL_OBSERVATION_CLASSES.has(
          schemaIfc.observes as LabelObservationClass,
        )
        ? schemaIfc.observes as LabelObservationClass
        : undefined,
    );
  }
  if (
    requestedObserves === undefined && existingObservationClasses.size > 1
  ) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(
      `Cannot preserve observes at "${location}": ` +
        "the effective label uses multiple observation classes.",
    );
  }
  const observes = requestedObserves ??
    (existingObservationClasses.size === 1
      ? existingObservationClasses.values().next().value
      : undefined);
  if (
    observes !== undefined &&
    (
      (schemaIfc !== undefined && schemaIfc.observes !== observes) ||
      currentView?.entries.some((entry) =>
        entry.path.length === 0 && entry.observes !== observes
      )
    )
  ) {
    const location = path.length === 0 ? "<root>" : path.join("/");
    throw new Error(
      `Cannot set observes to "${observes}" at "${location}": ` +
        "the effective label already uses a different observation class.",
    );
  }
  const tx = pieces.runtime.edit();
  targetCell.withTx(tx).asSchema({
    ifc: {
      ...label,
      ...(observes !== undefined ? { observes } : {}),
    },
  }).applyCfcSchemaToExistingValue();
  pieces.runtime.prepareTxForCommit(tx);
  const committed = await tx.commit();
  if (committed.error !== undefined) {
    throw new Error(
      `Could not set the CFC label at ${
        path.length === 0 ? "<root>" : path.join("/")
      }: ${committed.error.message}`,
    );
  }
  await pieces.synced();

  return cfcLabelViewForCommand(targetCell, path);
}

export async function getCellValue(
  config: PieceConfig,
  path: (string | number)[],
  options: GetCellValueOptions = {},
  deps: PieceOperationDependencies = {},
): Promise<unknown> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(
    config,
    pieces,
    deps.resolvePieceAddress,
  );
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
      const targetCell = rootCell.key(...path);
      await targetCell.pull();
      await pieces.synced();
      await pieces.runtime.idle();
      await pieces.synced();
    }

    const prop = options.input ? "input" : "result";
    if (options.selection !== undefined) {
      const rootCell = await piece[prop].getCell();
      const targetCell = rootCell.key(...path);
      let selected: unknown;
      try {
        selected = await (deps.deriveSelectedValue ?? deriveSelectedValue)(
          pieces.runtime,
          pieces.getSpace(),
          targetCell,
          options.selection,
        );
      } catch (error) {
        // The verb refusal wins over every selection error, not only the
        // "Cannot access path" family: a real `--filter` against a handler
        // fails inside the selector with a shape error that sends the caller
        // to their schema, when the answer is `cf piece call`. Classification
        // fails open, so an uncertain path keeps its original error.
        const verbRefusal = await verbReadRefusalOrNull(
          piece,
          prop,
          path,
          resolvedConfig.piece,
        );
        if (verbRefusal) throw verbRefusal;
        if (
          !options.input && error instanceof Error &&
          error.message.startsWith("Cannot access path") &&
          await resultProjectionFailedAtPath(piece, path)
        ) {
          throw new PieceResultProjectionError(path, shouldStep);
        }
        throw error;
      }
      // Read-path guard (verb contract WS-F): the selection path returns
      // early, so it needs the same verb refusal the plain read applies
      // below — a verb read through a selection is the same mistake.
      const selectionPathVerb = await classifyReadPathVerb(piece, prop, path);
      if (selectionPathVerb) {
        throw new PieceVerbReadError(
          selectionPathVerb.verb,
          resolvedConfig.piece,
          selectionPathVerb.callable,
        );
      }
      const sourceWasAbsent = typeof targetCell.getRaw === "function" &&
        targetCell.getRaw() === undefined;
      if (
        !options.input && selected === undefined &&
        await resultProjectionFailedAtPath(piece, path)
      ) {
        throw await verbReadRefusalOrNull(
          piece,
          prop,
          path,
          resolvedConfig.piece,
        ) ?? new PieceResultProjectionError(path, shouldStep);
      }
      if (selected === undefined && !sourceWasAbsent) {
        throw new CellSelectionError(
          "Cannot read selected value: the filter/schema expression did " +
            "not materialize a JSON-renderable value. This is not JSON " +
            "null. Retry with --step for a computed result, or inspect the " +
            "selected source data and schema.",
        );
      }
      return selected;
    }

    let value: unknown;
    try {
      value = await timeCliPhase(
        `getCellValue.${prop}.get`,
        () => piece[prop].get(path),
      );
    } catch (error) {
      if (
        !options.input && error instanceof Error &&
        error.message.startsWith("Cannot access path") &&
        await resultProjectionFailedAtPath(piece, path)
      ) {
        throw await verbReadRefusalOrNull(
          piece,
          prop,
          path,
          resolvedConfig.piece,
        ) ?? new PieceResultProjectionError(path, shouldStep);
      }
      throw error;
    }

    if (
      !options.input && value === undefined &&
      await resultProjectionFailedAtPath(piece, path)
    ) {
      throw await verbReadRefusalOrNull(
        piece,
        prop,
        path,
        resolvedConfig.piece,
      ) ?? new PieceResultProjectionError(path, shouldStep);
    }

    // Read-path guard (verb contract WS-F): a path that lands ON a verb would
    // return the stream's serialization — never what a caller wants — so it
    // refuses and redirects. Classified after the read so the piece's links
    // and schema are materialized locally.
    const verb = await classifyReadPathVerb(piece, prop, path);
    if (verb) {
      throw new PieceVerbReadError(
        verb.verb,
        resolvedConfig.piece,
        verb.callable,
      );
    }

    return value;
  } finally {
    if (shouldStep) {
      await pieces.stopPiece(resolvedConfig.piece);
    }
  }
}

export async function setCellValue(
  config: PieceConfig,
  path: (string | number)[],
  value: unknown,
  options?: { input?: boolean },
): Promise<void> {
  const pieces = await loadPieces(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
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
  const pieces = await timeCliPhase(
    "stepPiece.loadPieces",
    () => loadPieces(config),
  );
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
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
  await timeCliPhase("stepPiece.synced", () => pieces.synced());
  await timeCliPhase(
    "stepPiece.stop",
    () => pieces.stopPiece(resolvedConfig.piece),
  );
}

/**
 * Removes a piece from the space.
 */
export async function removePiece(config: PieceConfig): Promise<void> {
  const pieces = await loadPieces(config);
  const resolvedConfig = await resolvePieceConfigWithPieces(config, pieces);
  const removed = await pieces.remove(resolvedConfig.piece);

  if (!removed) {
    throw new Error(`Piece "${config.piece}" not found`);
  }
}

interface RootPatternDeps {
  loadPieces?: typeof loadPieces;
}

/**
 * Recreate the default/root pattern for an explicitly targeted space.
 */
export async function recreateSpaceRootPattern(
  config: SpaceConfig,
  deps: RootPatternDeps = {},
): Promise<string> {
  const pieces = await (deps.loadPieces ?? loadPieces)(config);
  const piece = await pieces.recreateDefaultPattern();
  return piece.id;
}

function isVNodeLike(value: unknown): value is VNode {
  const visited = new Set<object>();
  while (isObjectOrArray(value) && UI in value) {
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
  const pieces = await (deps.loadPieces ?? loadPieces)(homeConfig);
  const program = await (deps.getProgramFromFile ?? getProgramFromFile)(
    pieces,
    entry,
  );
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
  const pieces = await loadPieces(homeConfig);
  await pieces.recreateDefaultPattern();
}
