import type { CellScope, JSONSchema } from "@commonfabric/api";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  type CallableKind,
  classifyCallableEntry,
  patternFactoryFromCallableEntry,
  patternFactorySchemas,
} from "../../fuse/callables.ts";
import { prepareFactory } from "../../runner/src/factory-materialization.ts";
import type { Runtime } from "../../runner/src/runtime.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ExecCommandSpec } from "./exec-schema.ts";

export const CF_RUNTIME_ERROR_LOG = Symbol.for("cf.cli.runtimeErrorLog");
const DEFAULT_TOOL_RESULT_TIMEOUT_MS = 15_000;

export interface CliRuntimeErrorRecord {
  message: string;
  stackTrace?: string;
  pieceId?: string;
  patternId?: string;
  spellId?: string;
  space?: string;
}

export interface CallableTransactionStatus {
  status: string;
  error?: Error;
}

export interface CallableTransactionLike {
  status?: () => CallableTransactionStatus;
  commit?: () => Promise<unknown>;
}

export interface CallableCellLike {
  schema?: JSONSchema;
  get: () => unknown;
  getRaw?: () => unknown;
  resolveAsCell?: () => CallableCellLike;
  asSchemaFromLinks?: () => CallableCellLike;
  key: (segment: string) => CallableCellLike;
  pull?: () => Promise<unknown>;
  getAsNormalizedFullLink?: () => {
    id?: string;
    space?: string;
    scope?: CellScope;
  };
  send?: (
    value: unknown,
    onCommit?: (tx: CallableTransactionLike) => void,
  ) => void;
}

export interface CallablePieceIoLike {
  getCell: () => Promise<CallableCellLike>;
  set: (value: unknown, path?: (string | number)[]) => Promise<void>;
}

export interface CallableRuntimeLike {
  [CF_RUNTIME_ERROR_LOG]?: CliRuntimeErrorRecord[];
  storageManager?: { synced: () => Promise<void> };
  idle: () => Promise<void>;
  edit: () => CallableTransactionLike;
  getCell: (
    space: string,
    id: string,
    schema: JSONSchema | undefined,
    tx: CallableTransactionLike,
    scope?: CellScope,
  ) => CallableCellLike;
  run: (
    tx: CallableTransactionLike,
    pattern: unknown,
    input: unknown,
    resultCell: CallableCellLike,
  ) => { sink?: (fn: (value: unknown) => void) => (() => void) | void } | void;
  prepareTxForCommit?: (tx: CallableTransactionLike) => void;
}

export interface CallableManagerLike {
  runtime: CallableRuntimeLike;
  synced: () => Promise<void>;
  getSpace?: () => string;
}

export interface CallablePieceLike {
  input: CallablePieceIoLike;
  result: CallablePieceIoLike;
  getCell?: () => { pull?: () => Promise<unknown> };
}

export interface CallableResolution {
  callableCell: CallableCellLike;
  callableKind: CallableKind;
  cellKey: string;
  cellProp: "input" | "result";
  manager: CallableManagerLike;
  piece: CallablePieceLike;
  space: string;
}

export interface CallableExecutionDeps {
  timeoutMs?: number;
  uuid?: () => string;
  waitForResult?: (
    resultCell: CallableCellLike,
    timeoutMs: number,
  ) => Promise<unknown>;
  prepareFactory?: (
    factory: unknown,
    context: { runtime: CallableRuntimeLike; artifactSpace: string },
  ) => Promise<unknown>;
}

export interface ExecutedCallable {
  outputText?: string;
}

function canonicalFactorySelection(callableCell: CallableCellLike): {
  factory: unknown;
  leafCell: CallableCellLike;
} | undefined {
  const resolvedCell = resolveSourceCell(callableCell);
  for (const value of readCellCandidates(resolvedCell)) {
    if (isAdmittedFabricFactory(value)) {
      if (factoryStateOf(value).kind === "pattern") {
        return { factory: value, leafCell: resolvedCell };
      }
      continue;
    }
    const factory = patternFactoryFromCallableEntry(value);
    if (factory !== undefined) {
      return {
        factory,
        leafCell: resolveSourceCell(resolvedCell.key("pattern")),
      };
    }
  }

  try {
    const leafCell = resolveSourceCell(resolvedCell.key("pattern"));
    for (const nested of readCellCandidates(leafCell)) {
      if (
        isAdmittedFabricFactory(nested) &&
        factoryStateOf(nested).kind === "pattern"
      ) {
        return { factory: nested, leafCell };
      }
    }
  } catch {
    // A missing descriptor child simply means this is not a canonical factory.
  }
  return undefined;
}

function resolveSourceCell(cell: CallableCellLike): CallableCellLike {
  try {
    return cell.resolveAsCell?.() ?? cell;
  } catch {
    return cell;
  }
}

function readCellCandidates(cell: CallableCellLike): unknown[] {
  const candidates: unknown[] = [];
  if (typeof cell.getRaw === "function") {
    try {
      candidates.push(cell.getRaw());
    } catch {
      // A raw read may be unavailable even when the resolved read is valid.
    }
  }
  try {
    candidates.push(cell.get());
  } catch {
    // Treat unreadable cells as having no callable value.
  }
  return candidates;
}

function runtimeErrorLog(runtime: unknown): CliRuntimeErrorRecord[] {
  if (typeof runtime !== "object" || runtime === null) {
    return [];
  }
  const log = (runtime as { [CF_RUNTIME_ERROR_LOG]?: unknown })[
    CF_RUNTIME_ERROR_LOG
  ];
  return Array.isArray(log) ? log as CliRuntimeErrorRecord[] : [];
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }
  return String(error);
}

function normalizeToolInput(input: unknown): Record<string, unknown> {
  return typeof input === "object" && input !== null && !Array.isArray(input)
    ? input as Record<string, unknown>
    : input === undefined
    ? {}
    : { value: input };
}

async function defaultWaitForResult(
  resultCell: CallableCellLike,
  timeoutMs: number,
): Promise<unknown> {
  if (typeof resultCell.pull !== "function") {
    throw new Error("Callable result cell cannot be pulled");
  }
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    const value = await resultCell.pull();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for tool result after ${timeoutMs}ms`);
}

export function detectCallableKind(
  callableValue: unknown,
  callableCell: CallableCellLike,
): CallableKind | null {
  const resolvedCell = resolveSourceCell(callableCell);
  const candidates = [
    callableValue,
    ...readCellCandidates(resolvedCell),
    resolvedCell,
  ];
  for (const candidate of candidates) {
    const callableKind = classifyCallableEntry(
      candidate,
      callableCell.schema ?? resolvedCell.schema,
    );
    if (callableKind) {
      return callableKind;
    }
  }
  return null;
}

export function callableCommandSpec(
  callableCell: CallableCellLike,
  callableKind: CallableKind,
): ExecCommandSpec {
  if (callableKind === "handler") {
    return {
      callableKind: "handler",
      defaultVerb: "invoke",
      inputSchema: callableCell.schema ?? true,
    };
  }

  const canonical = canonicalFactorySelection(callableCell);
  const canonicalSchemas = canonical === undefined
    ? undefined
    : patternFactorySchemas(canonical.factory);
  if (canonicalSchemas) {
    return {
      callableKind: "tool",
      defaultVerb: "run",
      inputSchema: canonicalSchemas.argumentSchema,
      outputSchemaSummary: canonicalSchemas.resultSchema,
    };
  }

  throw new TypeError("Mounted tool requires a PatternFactory");
}

export async function executeResolvedCallable(
  resolved: CallableResolution,
  input: unknown,
  deps: CallableExecutionDeps = {},
): Promise<ExecutedCallable> {
  if (resolved.callableKind === "handler") {
    const send = resolved.callableCell.send;
    if (typeof send === "function") {
      const runtimeErrors = runtimeErrorLog(resolved.manager.runtime);
      const errorCountBefore = runtimeErrors.length;
      const tx = await new Promise<CallableTransactionLike>(
        (resolve, reject) => {
          try {
            send.call(resolved.callableCell, input, resolve);
          } catch (error) {
            reject(error);
          }
        },
      );
      await resolved.manager.runtime.idle();
      await resolved.manager.synced();

      const txStatus = tx?.status?.();
      if (txStatus?.status === "error") {
        const latestRuntimeError = runtimeErrors.slice(errorCountBefore).at(-1)
          ?.message;
        throw new Error(
          `Handler "${resolved.cellKey}" failed: ${
            latestRuntimeError ?? errorMessage(txStatus.error)
          }`,
        );
      }

      return {};
    }

    await resolved.piece[resolved.cellProp].set(input, [resolved.cellKey]);
    await resolved.manager.runtime.idle();
    await resolved.manager.synced();

    return {};
  }

  const canonical = canonicalFactorySelection(resolved.callableCell);
  if (!canonical) throw new TypeError("Mounted tool requires a PatternFactory");
  const schemas = patternFactorySchemas(canonical.factory);
  if (!schemas) throw new TypeError("Mounted tool requires a PatternFactory");
  const resultSchema = schemas.resultSchema;
  const sourceCell = canonical.leafCell.resolveAsCell?.() ?? canonical.leafCell;
  const artifactSpace = sourceCell.getAsNormalizedFullLink?.().space ??
    resolved.space;
  const pattern = await (deps.prepareFactory ??
    ((factory, context) =>
      prepareFactory(factory, {
        runtime: context.runtime as unknown as Runtime,
        artifactSpace: context.artifactSpace as MemorySpace,
      })))(canonical.factory, {
      runtime: resolved.manager.runtime,
      artifactSpace,
    });
  const tx = resolved.manager.runtime.edit();
  const resultScope = resolved.callableCell.getAsNormalizedFullLink?.().scope;
  const resultCell = resolved.manager.runtime.getCell(
    resolved.space,
    deps.uuid?.() ?? crypto.randomUUID(),
    resultSchema,
    tx,
    resultScope,
  );
  const running = resolved.manager.runtime.run(
    tx,
    pattern,
    normalizeToolInput(input),
    resultCell,
  );
  let sinkValue: unknown;
  let hasSinkValue = false;
  const cancelSink = typeof running?.sink === "function"
    ? running.sink((value) => {
      if (value !== undefined) {
        sinkValue = value;
        hasSinkValue = true;
      }
    })
    : undefined;

  let outputValue: unknown;
  try {
    await resolved.manager.runtime.idle();
    resolved.manager.runtime.prepareTxForCommit?.(tx);
    if (typeof tx.commit !== "function") {
      throw new Error("Callable runtime transaction is not committable");
    }
    await tx.commit();
    const waitForResult = deps.waitForResult ?? defaultWaitForResult;
    const timeoutMs = deps.timeoutMs ?? DEFAULT_TOOL_RESULT_TIMEOUT_MS;

    await resolved.manager.runtime.idle();
    await resolved.manager.synced();
    await resolved.manager.runtime.storageManager?.synced();
    if (hasSinkValue) {
      outputValue = sinkValue;
    } else {
      await waitForResult(resultCell, timeoutMs);
      await resolved.manager.runtime.storageManager?.synced();
      outputValue = await waitForResult(resultCell, timeoutMs);
    }
  } finally {
    cancelSink?.();
  }

  return {
    outputText: JSON.stringify(outputValue, null, 2),
  };
}
