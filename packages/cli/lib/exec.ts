import type { PieceManager } from "@commonfabric/piece";
import {
  type PiecePatternRef,
  PiecesController,
} from "@commonfabric/piece/ops";
import { basename, dirname, join, relative, resolve } from "@std/path";
import {
  type MountedCallablePath,
  parseMountedCallablePath,
} from "../../fuse/callable-path.ts";
import {
  type CallableCellLike,
  callableCommandSpec,
  type CallableManagerLike,
  type CallablePieceLike,
  detectCallableKind,
} from "./callable.ts";
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
  patternRef?: PiecePatternRef;
}

export interface ResolvedMountedCallableFile {
  absPath: string;
  callablePath: MountedCallablePath;
  callableCell: CallableCellLike;
  commandSpec: ExecCommandSpec;
  manager: CallableManagerLike;
  mount: { entry: MountStateEntry; path: string };
  piece: CallablePieceLike;
  pieceId: string;
  pieceMeta: MountedPieceMeta;
}

export interface ExecDependencies {
  stateDir?: string;
  loadManager?: (config: SpaceConfig) => Promise<CallableManagerLike>;
  loadPiece?: (
    manager: CallableManagerLike,
    pieceId: string,
  ) => Promise<CallablePieceLike>;
  stat?: (path: string) => Promise<Deno.FileInfo>;
  readDir?: (path: string) => AsyncIterable<Deno.DirEntry>;
  delay?: (ms: number) => Promise<void>;
  timeoutMs?: number;
  uuid?: () => string;
  waitForResult?: (
    resultCell: CallableCellLike,
    timeoutMs: number,
  ) => Promise<unknown>;
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

async function defaultLoadPiece(
  manager: CallableManagerLike,
  pieceId: string,
): Promise<CallablePieceLike> {
  return await new PiecesController(manager as unknown as PieceManager).get(
    pieceId,
    true,
  );
}

async function readMountedPieceMeta(
  absFilePath: string,
  callablePath: MountedCallablePath,
): Promise<MountedPieceMeta> {
  const metaPath = join(
    callablePath.rootLevel
      ? dirname(absFilePath)
      : dirname(dirname(absFilePath)),
    "meta.json",
  );
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

  const rawPatternRef = meta.patternRef;
  const rawPatternSource = typeof rawPatternRef === "object" &&
      rawPatternRef !== null && !Array.isArray(rawPatternRef)
    ? (rawPatternRef as Record<string, unknown>).source
    : undefined;
  const patternSource = typeof rawPatternSource === "object" &&
      rawPatternSource !== null && !Array.isArray(rawPatternSource) &&
      typeof (rawPatternSource as Record<string, unknown>).ref === "string"
    ? {
      ref: (rawPatternSource as Record<string, unknown>).ref as string,
      ...(typeof (rawPatternSource as Record<string, unknown>).repository ===
          "string"
        ? {
          repository: (rawPatternSource as Record<string, unknown>)
            .repository as string,
        }
        : {}),
      ...(typeof (rawPatternSource as Record<string, unknown>).entry ===
          "string"
        ? {
          entry: (rawPatternSource as Record<string, unknown>).entry as string,
        }
        : {}),
      ...(typeof (rawPatternSource as Record<string, unknown>).origin ===
          "string"
        ? {
          origin: (rawPatternSource as Record<string, unknown>)
            .origin as string,
        }
        : {}),
    }
    : undefined;
  const patternRef = typeof rawPatternRef === "object" &&
      rawPatternRef !== null && !Array.isArray(rawPatternRef) &&
      typeof (rawPatternRef as Record<string, unknown>).identity === "string" &&
      typeof (rawPatternRef as Record<string, unknown>).symbol === "string" &&
      patternSource !== undefined
    ? {
      identity: (rawPatternRef as Record<string, unknown>).identity as string,
      symbol: (rawPatternRef as Record<string, unknown>).symbol as string,
      source: patternSource,
    }
    : undefined;

  return {
    id: meta.id,
    entityId: typeof meta.entityId === "string" ? meta.entityId : undefined,
    name: typeof meta.name === "string" ? meta.name : undefined,
    patternRef,
  };
}

// FUSE-T serves mounts through the macOS NFS client and ignores the entry
// and attribute cache timeouts the filesystem implementation returns, so
// the fuse bridge cannot shorten or disable the client's caching from its
// side. The NFS client answers a negative name lookup from its cache for
// tens of seconds, and serves a cached parent directory listing without a
// daemon round-trip for up to about three seconds after the directory was
// last listed. A listing miss is therefore only authoritative once that
// validity window has passed since the miss was first observed, so this
// wait must exceed the window; it includes margin over the observed three
// seconds.
const DIR_LISTING_RECHECK_DELAY_MS = 3500;

async function parentListingHasFile(
  absPath: string,
  readDir: (path: string) => AsyncIterable<Deno.DirEntry>,
): Promise<boolean> {
  const name = basename(absPath);
  try {
    for await (const entry of readDir(dirname(absPath))) {
      if (entry.name === name && !entry.isDirectory) {
        return true;
      }
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
  }
  return false;
}

async function assertMountedCallableFileExists(
  absPath: string,
  deps: ExecDependencies = {},
): Promise<void> {
  const stat = deps.stat ?? Deno.stat;
  const readDir = deps.readDir ?? Deno.readDir;
  const delay = deps.delay ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  try {
    if ((await stat(absPath)).isFile) {
      return;
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) {
      throw error;
    }
    // While the fuse bridge rebuilds a piece prop it clears the subtree and
    // re-hydrates it on demand, and FUSE-T cannot push cache invalidations
    // to the kernel, so a stat during that window reports NotFound for a
    // callable file that exists: the NFS client's negative name cache keeps
    // answering NotFound long after the bridge has the file again. A parent
    // directory listing that reaches the bridge is answered after hydration
    // and names every callable file that exists. The listing entry's type
    // flags come from the same cached attributes as the stat, so a name
    // match counts as existence unless the entry is a directory.
    if (await parentListingHasFile(absPath, readDir)) {
      return;
    }
    // The listing can itself be served from a client cache that predates
    // the file. Wait out the cache validity window and consult the listing
    // once more; a second miss means the file does not exist.
    await delay(DIR_LISTING_RECHECK_DELAY_MS);
    if (await parentListingHasFile(absPath, readDir)) {
      return;
    }
  }
  throw new Error(`Mounted callable file not found: ${absPath}`);
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

  const canonicalMountpoint = await canonicalizeMountLookupPath(
    mount.entry.mountpoint,
  );
  const canonicalAbsPath = await canonicalizeMountLookupPath(absPath);
  const relativePath = relative(
    canonicalMountpoint,
    canonicalAbsPath,
  );
  const callablePath = parseMountedCallablePath(relativePath);
  if (!callablePath) {
    throw new Error(`Path is not a mounted callable file: ${absPath}`);
  }

  await assertMountedCallableFileExists(canonicalAbsPath, deps);
  const pieceMeta = await readMountedPieceMeta(canonicalAbsPath, callablePath);
  const manager = deps.loadManager
    ? await deps.loadManager({
      apiUrl: mount.entry.apiUrl,
      identity: mount.entry.identity,
      space: callablePath.spaceName,
    })
    : await loadManager({
      apiUrl: mount.entry.apiUrl,
      identity: mount.entry.identity,
      space: callablePath.spaceName,
    }) as unknown as CallableManagerLike;
  const piece = await (deps.loadPiece ?? defaultLoadPiece)(
    manager,
    pieceMeta.id,
  );
  const rootCell = await piece[callablePath.cellProp].getCell();
  const childCell = rootCell.key(callablePath.cellKey);
  const callableCell = childCell.asSchemaFromLinks?.() ?? childCell;
  const actualKind = detectCallableKind(undefined, callableCell);
  if (actualKind !== callablePath.callableKind) {
    throw new Error(
      `Mounted callable path "${absPath}" does not resolve to a ${callablePath.callableKind}`,
    );
  }

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
  if (!result.helpText && typeof resolved.piece.getCell === "function") {
    try {
      const pieceCell = resolved.piece.getCell();
      if (typeof pieceCell.pull === "function") {
        await pieceCell.pull();
      }
      await resolved.manager.synced();
    } catch {
      // Auto-step is best-effort; the handler already executed successfully.
    }
  }

  return result;
}
