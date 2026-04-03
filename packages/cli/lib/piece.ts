import { createSession, isDID, Session } from "@commonfabric/identity";
import { ensureDir } from "@std/fs";
import { loadIdentity } from "./identity.ts";
import { Runtime, RuntimeProgram, UI, VNode } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache";
import { extractUserCode, pieceId, PieceManager } from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import { dirname, join } from "@std/path";
import { FileSystemProgramResolver } from "@commonfabric/js-compiler";
import { setLLMUrl } from "@commonfabric/llm";
import { isRecord } from "@commonfabric/utils/types";
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
import {
  type ExecCommandSpec,
  normalizeCallableInputForExecution,
  type ParsedExecArgs,
  renderExecHelpJson,
  renderPieceCallHelp,
  resolveExecInvocation,
} from "./exec-schema.ts";
import { cliCommand } from "./cli-name.ts";

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
}

export interface ResolvedPieceCallable extends CallableResolution {
  commandSpec: ExecCommandSpec;
}

export interface PieceCallableDependencies extends CallableExecutionDeps {
  helpCommandPrefix?: string;
  loadManager?: (config: SpaceConfig) => Promise<any>;
  loadPiece?: (manager: any, pieceId: string) => Promise<any>;
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
  const session = await makeSession(config);
  // Use a const ref object so we can assign later while keeping const binding
  const pieceManagerRef: { current?: PieceManager } = {};
  const runtimeErrors: CliRuntimeErrorRecord[] = [];
  const runtime = new Runtime({
    apiUrl: new URL(config.apiUrl),
    experimental: experimentalOptionsFromEnv(),
    storageManager: StorageManager.open({
      as: session.as,
      address: new URL("/api/storage/memory", config.apiUrl),
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
        runtime.storageManager.synced().then(async () => {
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
        }).catch((_err) => {
          // ignore; we already emitted the id
        });
      } catch (e) {
        console.error("navigateTo callback error:", e);
      }
    },
  });
  (runtime as Runtime & { [CF_RUNTIME_ERROR_LOG]?: CliRuntimeErrorRecord[] })[
    CF_RUNTIME_ERROR_LOG
  ] = runtimeErrors;

  if (!(await runtime.healthCheck())) {
    throw new Error(`Could not connect to "${config.apiUrl.toString()}".`);
  }

  const pieceManager = new PieceManager(session, runtime);
  pieceManagerRef.current = pieceManager;
  await awaitSyncWithTimeout(pieceManager.synced());
  return pieceManager;
}

async function getProgramFromFile(
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

// Returns an array of metadata about pieces to display.
export async function listPieces(
  config: SpaceConfig,
): Promise<
  { id: string; name?: string; patternName?: string; error?: string }[]
> {
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const allPieces = await pieces.getAllPieces();
  return Promise.all(
    allPieces.map(async (piece) => {
      try {
        return {
          id: piece.id,
          name: piece.name(),
          patternName: (await piece.getPatternMeta()).patternName,
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

// Creates a new piece from source code and optional input.
export async function newPiece(
  config: SpaceConfig,
  entry: EntryConfig,
  options?: { start?: boolean },
): Promise<string> {
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);

  // Try to ensure default pattern, but don't fail the entire operation
  try {
    await pieces.ensureDefaultPattern();
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

  const program = await getProgramFromFile(manager, entry);
  const piece = await pieces.create(program, options);

  // Explicitly add the piece to the space's allPieces list
  await manager.add([piece.getCell()]);

  return piece.id;
}

export async function setPiecePattern(
  config: PieceConfig,
  entry: EntryConfig,
): Promise<void> {
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(config.piece, false);
  if (entry.mainPath.endsWith(".iframe.js")) {
    await piece.setIframePattern(entry.mainPath);
  } else {
    await piece.setPattern(await getProgramFromFile(manager, entry));
  }
}

export async function savePiecePattern(
  config: PieceConfig,
  outPath: string,
): Promise<void> {
  await ensureDir(outPath);
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(config.piece, false);
  const meta = await piece.getPatternMeta();
  const iframePattern = piece.getIframePattern();

  if (iframePattern) {
    const userCode = extractUserCode(iframePattern.src);
    if (!userCode) {
      throw new Error(
        `No user code found in iframe pattern "${config.piece}".`,
      );
    }
    await Deno.writeTextFile(
      join(outPath, "main.iframe.js"),
      userCode,
    );
  } else if (meta.src) {
    // Write the main source file
    await Deno.writeTextFile(join(outPath, "main.tsx"), meta.src);
  } else if (meta.program) {
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
      `Piece "${config.piece}" does not contain a pattern source.`,
    );
  }
}

export async function applyPieceInput(
  config: PieceConfig,
  input: object,
) {
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(config.piece, false);
  await piece.setInput(input);
}

function getCallableValue(rootValue: unknown, callableName: string): unknown {
  if (
    typeof rootValue !== "object" || rootValue === null ||
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
      [callableName]: { asStream: true },
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
  );
  manager.runtime.run(tx, pattern, input, liveResult);
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

  const piece =
    await (deps.loadPiece
      ? deps.loadPiece(manager, config.piece)
      : pieces.get(config.piece, true));
  const space = manager.getSpace?.() ?? config.space;

  const resolved = await tryResolvePieceCallableAt(
    piece,
    manager,
    space,
    callableName,
    "result",
  ) ?? await tryResolvePieceCallableAt(
    piece,
    manager,
    space,
    callableName,
    "input",
  ) ?? await tryResolvePieceHandler(piece, manager, space, callableName);
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
  const invocation = await resolveExecInvocation(
    resolved.commandSpec,
    rawArgs,
    deps,
  );
  const parsed = invocation.parsed;

  if (parsed.showHelp) {
    return {
      helpText: parsed.showHelpJson
        ? renderExecHelpJson(resolved.commandSpec)
        : renderPieceCallHelp(
          deps.helpCommandPrefix ??
            cliCommand(["piece", "call", "...", callableName]),
          resolved.commandSpec,
        ),
      parsed,
      resolved,
    };
  }

  const input = invocation.input;
  const executed = await executeResolvedCallable(
    resolved,
    parsed.usedJsonInput
      ? input
      : normalizeCallableInputForExecution(resolved.commandSpec, input),
    deps,
  );

  return {
    outputText: executed.outputText,
    parsed,
    resolved,
  };
}

export async function linkPieces(
  config: SpaceConfig,
  sourcePieceId: string,
  sourcePath: (string | number)[],
  targetPieceId: string,
  targetPath: (string | number)[],
  options?: { start?: boolean; allowNonExisting?: boolean },
): Promise<void> {
  const manager = await loadManager(config);

  // Ensure default pattern exists (best effort)
  let pieces: PiecesController;
  try {
    pieces = new PiecesController(manager);
    await pieces.ensureDefaultPattern();
  } catch (error) {
    // Non-fatal, log and continue
    console.warn(
      `Warning: Could not ensure default pattern: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    pieces = new PiecesController(manager);
  }

  // Validate that source and target pieces/paths exist by reading them
  if (!options?.allowNonExisting) {
    const errors: string[] = [];

    // Check source piece exists by verifying it has a source/process cell
    // (i.e., was created via cf piece new, not just written to with cf piece set)
    const sourcePiece = await pieces.get(sourcePieceId, false);
    const sourceHasProcess =
      sourcePiece.getCell().getSourceCell() !== undefined;
    if (!sourceHasProcess) {
      errors.push(`Source piece ${sourcePieceId} does not exist`);
    } else if (sourcePath.length > 0) {
      const sourceData = await sourcePiece.result.get();
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

    // Check target piece exists by verifying it has a source/process cell
    const targetPiece = await pieces.get(targetPieceId, false);
    const targetHasProcess =
      targetPiece.getCell().getSourceCell() !== undefined;
    if (!targetHasProcess) {
      errors.push(`Target piece ${targetPieceId} does not exist`);
    } else if (targetPath.length > 0) {
      // Check target path resolves on the input cell
      const targetData = await targetPiece.input.get();
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
        errors.join("\n") +
          "\n\nUse --allow-non-existing to link anyway.",
      );
    }
  }

  await manager.link(
    sourcePieceId,
    sourcePath,
    targetPieceId,
    targetPath,
    options,
  );
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
      (b.readingFrom.length + b.readBy.length) -
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
): Promise<{
  id: string;
  name?: string;
  patternName?: string;
  source: Readonly<unknown>;
  result: Readonly<unknown>;
  readingFrom: Array<{ id: string; name?: string }>;
  readBy: Array<{ id: string; name?: string }>;
}> {
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(config.piece, false);

  const id = piece.id;
  const name = piece.name();
  const patternName = (await piece.getPatternMeta()).patternName;
  const source = await piece.input.get() as Readonly<unknown>;
  const result = await piece.result.get() as Readonly<unknown>;
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
    patternName,
    source,
    result,
    readingFrom,
    readBy,
  };
}

export async function getPieceView(
  config: PieceConfig,
): Promise<unknown> {
  const data = await inspectPiece(config) as any;
  return data.result?.[UI] as VNode;
}

export function formatViewTree(view: unknown): string {
  const format = (
    node: unknown,
    prefix: string,
    last: boolean,
  ): string => {
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
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(config.piece, false);
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
  const pieces = new PiecesController(manager);
  const piece = await pieces.get(config.piece, false);
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
  const resolved = await resolvePieceCallable(config, handlerName);
  if (resolved.callableKind !== "handler") {
    throw new Error(`Callable "${handlerName}" is not a handler`);
  }
  await executeResolvedCallable(resolved, args);
}

/**
 * Removes a piece from the space.
 */
export async function removePiece(
  config: PieceConfig,
): Promise<void> {
  const manager = await loadManager(config);
  const pieces = new PiecesController(manager);
  const removed = await pieces.remove(config.piece);

  if (!removed) {
    throw new Error(`Piece "${config.piece}" not found`);
  }
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
