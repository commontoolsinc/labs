import { PiecesController } from "@commonfabric/piece/ops";
import { dirname, join, relative, resolve } from "@std/path";
import {
  type MountedCallablePath,
  parseMountedCallablePath,
} from "../../fuse/callable-path.ts";
import { callableCommandSpec } from "./callable.ts";
import { executeCallableCommand } from "./callable-command.ts";
import {
  type ExecCommandSpec,
  type ParsedExecArgs,
  renderExecHelp,
  renderExecHelpJson,
} from "./exec-schema.ts";
import {
  canonicalizeMountLookupPath,
  findMountForPath,
  type MountStateEntry,
} from "./fuse.ts";
import { loadManager, type SpaceConfig } from "./piece.ts";

export interface MountedPieceMeta {
  id: string;
  entityId?: string;
  name?: string;
  patternName?: string;
}

export interface ResolvedMountedCallableFile {
  absPath: string;
  callablePath: MountedCallablePath;
  callableCell: any;
  commandSpec: ExecCommandSpec;
  manager: any;
  mount: { entry: MountStateEntry; path: string };
  piece: any;
  pieceId: string;
  pieceMeta: MountedPieceMeta;
}

export interface ExecDependencies {
  stateDir?: string;
  loadManager?: (config: SpaceConfig) => Promise<any>;
  loadPiece?: (manager: any, pieceId: string) => Promise<any>;
  timeoutMs?: number;
  uuid?: () => string;
  waitForResult?: (resultCell: any, timeoutMs: number) => Promise<unknown>;
  invocationStyle?: "cf" | "direct";
  readJsonInput?: () => Promise<unknown>;
  readTextInput?: () => Promise<string>;
  readTextFile?: (path: string) => Promise<string>;
  isStdinTerminal?: () => boolean;
}

export interface ExecutedMountedCallableFile {
  helpText?: string;
  outputText?: string;
  parsed: ParsedExecArgs;
  resolved: ResolvedMountedCallableFile;
}

async function defaultLoadPiece(manager: any, pieceId: string) {
  return await new PiecesController(manager).get(pieceId, true);
}

async function readMountedPieceMeta(
  absFilePath: string,
): Promise<MountedPieceMeta> {
  const metaPath = join(dirname(dirname(absFilePath)), "meta.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await Deno.readTextFile(metaPath));
  } catch {
    throw new Error(`Mounted piece metadata not found for ${absFilePath}`);
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`Mounted piece metadata is invalid for ${absFilePath}`);
  }

  const meta = parsed as Record<string, unknown>;
  if (typeof meta.id !== "string" || meta.id.length === 0) {
    throw new Error(`Mounted piece metadata missing id for ${absFilePath}`);
  }

  return {
    id: meta.id,
    entityId: typeof meta.entityId === "string" ? meta.entityId : undefined,
    name: typeof meta.name === "string" ? meta.name : undefined,
    patternName: typeof meta.patternName === "string"
      ? meta.patternName
      : undefined,
  };
}

async function assertMountedCallableFileExists(absPath: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    let stat: Deno.FileInfo;
    try {
      stat = await Deno.stat(absPath);
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) {
        if (attempt < 19) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          continue;
        }
        throw new Error(`Mounted callable file not found: ${absPath}`);
      }
      throw error;
    }

    if (stat.isFile) {
      return;
    }

    if (attempt < 19) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    throw new Error(`Mounted callable file not found: ${absPath}`);
  }
}

export async function resolveMountedCallableFile(
  filePath: string,
  deps: ExecDependencies = {},
): Promise<ResolvedMountedCallableFile> {
  const absPath = resolve(filePath);
  const mount = await findMountForPath(absPath, deps.stateDir);
  if (!mount) {
    throw new Error(
      `Path is not within a mounted cf fuse filesystem: ${absPath}`,
    );
  }

  const relativePath = relative(
    await canonicalizeMountLookupPath(mount.entry.mountpoint),
    await canonicalizeMountLookupPath(absPath),
  );
  const callablePath = parseMountedCallablePath(relativePath);
  if (!callablePath) {
    throw new Error(`Path is not a mounted callable file: ${absPath}`);
  }

  await assertMountedCallableFileExists(absPath);
  const pieceMeta = await readMountedPieceMeta(absPath);
  const manager = await (deps.loadManager ?? loadManager)({
    apiUrl: mount.entry.apiUrl,
    identity: mount.entry.identity,
    space: callablePath.spaceName,
  });
  const piece = await (deps.loadPiece ?? defaultLoadPiece)(
    manager,
    pieceMeta.id,
  );
  const rootCell = await piece[callablePath.cellProp].getCell();
  const callableCell = rootCell.key(callablePath.cellKey).asSchemaFromLinks();

  return {
    absPath,
    callablePath,
    callableCell,
    commandSpec: callableCommandSpec(callableCell, callablePath.callableKind),
    manager,
    mount,
    piece,
    pieceId: pieceMeta.id,
    pieceMeta,
  };
}

export async function executeMountedCallableFile(
  filePath: string,
  rawArgs: string[],
  deps: ExecDependencies = {},
): Promise<ExecutedMountedCallableFile> {
  const resolved = await resolveMountedCallableFile(filePath, deps);
  const invocationStyle = deps.invocationStyle ??
    (Deno.env.get("CF_EXEC_SHEBANG") === "1" ? "direct" : "cf");
  const result = await executeCallableCommand({
    resolved,
    execution: {
      callableCell: resolved.callableCell,
      callableKind: resolved.callablePath.callableKind,
      cellKey: resolved.callablePath.cellKey,
      cellProp: resolved.callablePath.cellProp,
      manager: resolved.manager,
      piece: resolved.piece,
      space: resolved.manager.getSpace?.() ?? resolved.callablePath.spaceName,
    },
    commandSpec: resolved.commandSpec,
    rawArgs,
    deps,
    renderHelp: (commandSpec, parsed) =>
      parsed.showHelpJson
        ? renderExecHelpJson(commandSpec)
        : renderExecHelp(filePath, commandSpec, {
          invocationStyle,
        }),
  });

  // Auto-step: trigger reactive recomputation after handler execution.
  // Skip if --help was shown — no mutation occurred.
  if (!result.helpText && typeof resolved.piece?.getCell === "function") {
    try {
      await resolved.piece.getCell().pull();
      await resolved.manager.synced();
    } catch {
      // Auto-step is best-effort; the handler already executed successfully.
    }
  }

  return result;
}
