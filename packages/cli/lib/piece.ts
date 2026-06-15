import { createSession, isDID, Session } from "@commonfabric/identity";
import { ensureDir } from "@std/fs";
import { loadIdentity } from "./identity.ts";
import {
  Cell,
  getMetaLink,
  NAME,
  Runtime,
  RuntimeProgram,
  UI,
  VNode,
} from "@commonfabric/runner";
import type { CellScope } from "@commonfabric/api";
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
import { PiecesController } from "@commonfabric/piece/ops";
import { dirname, join } from "@std/path";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { setLLMUrl } from "@commonfabric/llm";
import { isRecord } from "@commonfabric/utils/types";
import { pinProgramFabricImports, renderPinRewrite } from "./fabric-deps.ts";
import { isHandlerCell } from "../../fuse/callables.ts";
import { awaitSyncWithTimeout, experimentalOptionsFromEnv } from "./utils.ts";
import {
  callableCommandSpec,
  type CallableExecutionDeps,
  type CallableResolution,
  CF_RUNTIME_ERROR_LOG,
  type CliRuntimeErrorRecord,
  detectCallableKind,
  executeResolvedCallable,
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
  rootPath?: string;
}

export interface SpaceConfig {
  apiUrl: string;
  space: string;
  identity: string;
}

export interface PieceConfig extends SpaceConfig {
  piece: string;
  pieceScope?: CellScope;
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
      new Runtime({
        apiUrl: new URL(config.apiUrl),
        experimental: experimentalOptionsFromEnv(),
        storageManager: StorageManager.open({
          as: session.as,
          memoryHost: new URL(config.apiUrl),
          spaceIdentity: session.spaceIdentity,
        }),
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
      }),
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
): Promise<
  { id: string; name?: string; error?: string }[]
> {
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const allPieces = await pieces.getAllPieces();
  return Promise.all(
    allPieces.map(async (piece) => {
      try {
        const livePiece = await pieces.get(piece.id, true);
        const name = (await (
          livePiece.getCell().key(NAME) as Cell<unknown>
        ).pull()) as string | undefined;
        return {
          id: piece.id,
          name,
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
      error.code === "missing"
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
): Promise<string> {
  const manager = await timeCliPhase(
    "newPiece.loadManager",
    () => loadManager(config),
  );
  const pieces = new PiecesController(manager);

  // Try to ensure default pattern, but don't fail the entire operation
  try {
    await timeCliPhase(
      "newPiece.ensureDefaultPattern",
      () => pieces.ensureDefaultPattern(),
    );
  } catch (error) {
    console.warn(
      `Warning: Could not initialize default pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    console.warn(
      "Patterns using wish({ query: '#mentionable' }) or wish({ query: '#default' }) may not work.",
    );
    // Continue anyway - user's pattern might not need defaultPattern
  }

  const program = await timeCliPhase(
    "newPiece.getProgramFromFile",
    () => getPinnedProgramFromFile(manager, entry),
  );
  const PIECE_START_TIMEOUT_MS = 60_000;
  const piece = await timeCliPhase("newPiece.create", () => {
    const createPromise = pieces.create(program, { start: options?.start });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `Piece created but failed to start within ${
              PIECE_START_TIMEOUT_MS / 1000
            }s. ` + `Check toolshed logs for runtime errors.`,
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
      { "/": resolvedSourcePieceId },
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
  await piece.setPattern(await getPinnedProgramFromFile(manager, entry));
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
  const meta = await piece.getPatternMeta();

  if (meta.program) {
    for (const { name, contents } of meta.program.files) {
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

async function resolvePieceCallable(
  config: PieceConfig,
  callableName: string,
  deps: PieceCallableDependencies = {},
): Promise<ResolvedPieceCallable> {
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
    const sourcePatternLink = getMetaLink(sourcePiece.getCell(), "pattern");
    if (sourcePatternLink === undefined) {
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
    const targetPatternLink = getMetaLink(targetPiece.getCell(), "pattern");
    if (targetPatternLink === undefined) {
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
    { "/": id },
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

export async function inspectPiece(config: PieceConfig): Promise<{
  id: string;
  name?: string;
  source?: Readonly<unknown>;
  result: Readonly<unknown>;
  readingFrom: Array<{ id: string; name?: string }>;
  readBy: Array<{ id: string; name?: string }>;
}> {
  const manager = await loadManager(config);
  let resolvedConfig: PieceConfig;
  try {
    resolvedConfig = await resolvePieceConfigWithManager(config, manager);
  } catch (error) {
    if (
      error instanceof SlugResolutionError &&
      error.code === "not-piece"
    ) {
      return await inspectSlugTargetCell(manager, config.piece);
    }
    throw error;
  }
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(
    resolvedConfig.piece,
    false,
    undefined,
    resolvedConfig.pieceScope,
  );

  const id = piece.id;
  const name = piece.name();
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

  return {
    id: slug,
    name,
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
  options?: { input?: boolean },
): Promise<unknown> {
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
    return await piece.input.get(path);
  } else {
    return await piece.result.get(path);
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
): Promise<void> {
  const identity = await loadIdentity(config.identity);
  const homeConfig: SpaceConfig = { ...config, space: identity.did() };
  const manager = await loadManager(homeConfig);
  const program = await getProgramFromFile(manager, entry);
  const pieces = new PiecesController(manager);
  await pieces.recreateDefaultPattern({ customProgram: program });
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
