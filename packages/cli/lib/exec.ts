import type { JSONSchema } from "@commontools/api";
import { PiecesController } from "@commontools/piece/ops";
import { dirname, join, relative, resolve } from "@std/path";
import {
  type MountedCallablePath,
  parseMountedCallablePath,
} from "../../fuse/callable-path.ts";
import {
  type ExecCommandSpec,
  type ParsedExecArgs,
  parseExecArgs,
  renderExecHelp,
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
}

export interface ExecutedMountedCallableFile {
  helpText?: string;
  outputText?: string;
  parsed: ParsedExecArgs;
  resolved: ResolvedMountedCallableFile;
}

function isSchemaObject(schema: JSONSchema | undefined): schema is Record<
  string,
  unknown
> {
  return typeof schema === "object" && schema !== null &&
    !Array.isArray(schema);
}

function cloneWithoutBoundToolKeys(
  schema: JSONSchema,
  extraParams: Record<string, unknown>,
): JSONSchema {
  if (!isSchemaObject(schema)) return schema;
  if (schema.type !== "object" && !schema.properties) return schema;

  const rawProperties = schema.properties;
  if (
    typeof rawProperties !== "object" || rawProperties === null ||
    Array.isArray(rawProperties)
  ) {
    return schema;
  }

  const properties = {
    ...(rawProperties as Record<string, JSONSchema>),
  };
  delete properties.result;
  for (const key of Object.keys(extraParams)) {
    delete properties[key];
  }

  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((key) =>
      key !== "result" && !(key in extraParams)
    )
    : undefined;

  return {
    ...schema,
    properties,
    ...(required ? { required } : {}),
  };
}

function callableCommandSpec(
  callablePath: MountedCallablePath,
  callableCell: any,
): ExecCommandSpec {
  if (callablePath.callableKind === "handler") {
    return {
      callableKind: "handler",
      defaultVerb: "invoke",
      inputSchema: callableCell.schema ?? true,
    };
  }

  const pattern = callableCell.key("pattern").getRaw?.() ??
    callableCell.key("pattern").get();
  const extraParams = callableCell.key("extraParams").get() ?? {};

  return {
    callableKind: "tool",
    defaultVerb: "run",
    inputSchema: cloneWithoutBoundToolKeys(
      pattern?.argumentSchema ?? true,
      extraParams,
    ),
    outputSchemaSummary: pattern?.resultSchema,
  };
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
  let stat: Deno.FileInfo;
  try {
    stat = await Deno.stat(absPath);
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      throw new Error(`Mounted callable file not found: ${absPath}`);
    }
    throw error;
  }

  if (!stat.isFile) {
    throw new Error(`Mounted callable file not found: ${absPath}`);
  }
}

function mergeToolInput(
  input: unknown,
  extraParams: Record<string, unknown>,
): Record<string, unknown> {
  const base =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? input as Record<string, unknown>
      : input === undefined
      ? {}
      : { value: input };

  return {
    ...base,
    ...extraParams,
  };
}

async function defaultWaitForResult(
  resultCell: { get: () => unknown },
  timeoutMs: number,
): Promise<unknown> {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const value = resultCell.get();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for tool result after ${timeoutMs}ms`);
}

export async function resolveMountedCallableFile(
  filePath: string,
  deps: ExecDependencies = {},
): Promise<ResolvedMountedCallableFile> {
  const absPath = resolve(filePath);
  const mount = await findMountForPath(absPath, deps.stateDir);
  if (!mount) {
    throw new Error(
      `Path is not within a mounted ct fuse filesystem: ${absPath}`,
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
    commandSpec: callableCommandSpec(callablePath, callableCell),
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
  const parsed = parseExecArgs(resolved.commandSpec, rawArgs);

  if (parsed.showHelp) {
    return {
      helpText: renderExecHelp(resolved.absPath, resolved.commandSpec),
      parsed,
      resolved,
    };
  }

  if (resolved.callablePath.callableKind === "handler") {
    await resolved.piece[resolved.callablePath.cellProp].set(
      parsed.input,
      [resolved.callablePath.cellKey],
    );
    await resolved.manager.runtime.idle();
    await resolved.manager.synced();

    return {
      parsed,
      resolved,
    };
  }

  const pattern = resolved.callableCell.key("pattern").getRaw?.() ??
    resolved.callableCell.key("pattern").get();
  const extraParams = resolved.callableCell.key("extraParams").get() ?? {};
  const tx = resolved.manager.runtime.edit();
  const resultCell = resolved.manager.runtime.getCell(
    resolved.manager.getSpace?.() ?? resolved.callablePath.spaceName,
    deps.uuid?.() ?? crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
  );
  resolved.manager.runtime.run(
    tx,
    pattern,
    mergeToolInput(parsed.input, extraParams),
    resultCell,
  );
  await tx.commit();
  await resolved.manager.runtime.idle();
  await resolved.manager.synced();

  const outputValue = await (deps.waitForResult ?? defaultWaitForResult)(
    resultCell,
    deps.timeoutMs ?? 5000,
  );

  return {
    outputText: JSON.stringify(outputValue, null, 2),
    parsed,
    resolved,
  };
}
