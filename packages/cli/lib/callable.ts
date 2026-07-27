import type { CellScope, JSONSchema } from "@commonfabric/api";
import {
  factoryStateOf,
  isAdmittedFabricFactory,
} from "@commonfabric/data-model/fabric-factory";
import {
  entityRefToString,
  isEntityRef,
  linkRefFrom,
} from "@commonfabric/data-model/cell-rep";
import {
  type CallableKind,
  classifyCallableEntry,
  patternFactoryFromCallableEntry,
  patternFactorySchemas,
} from "../../fuse/callables.ts";
import { prepareFactory } from "../../runner/src/factory-materialization.ts";
import { getFrameworkProvidedPaths } from "../../runner/src/builder/pattern-metadata.ts";
import { getEntityId } from "../../runner/src/create-ref.ts";
import {
  applyFrameworkProvidedInputs,
  stripFrameworkProvidedPaths,
} from "../../runner/src/framework-provided-inputs.ts";
import type { Runtime } from "../../runner/src/runtime.ts";
import type { MemorySpace } from "@commonfabric/memory/interface";
import type { ExecCommandSpec } from "./exec-schema.ts";

export const CF_RUNTIME_ERROR_LOG = Symbol.for("cf.cli.runtimeErrorLog");
const preparedCallableTools = new WeakSet<object>();

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
    path?: readonly (string | number)[];
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
  // Drain to full quiescence: scheduler idle, storage synced, and every
  // in-flight async builtin (an LLM call, a fetch) finished. This is how a tool
  // whose result arrives asynchronously is awaited without polling or a
  // deadline. Optional so lightweight test doubles can omit it.
  settled?: () => Promise<void>;
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
  /** Stable containing call-site identity when the executable value is read elsewhere. */
  identityCell?: CallableCellLike;
  callableKind: CallableKind;
  cellKey: string;
  cellProp: "input" | "result";
  manager: CallableManagerLike;
  piece: CallablePieceLike;
  space: string;
  preparedTool?: PreparedCallableTool;
}

export interface CallableExecutionDeps {
  uuid?: () => string;
  prepareFactory?: (
    factory: unknown,
    context: { runtime: CallableRuntimeLike; artifactSpace: string },
  ) => Promise<unknown>;
}

export interface ExecutedCallable {
  outputText?: string;
}

export interface PreparedCallableTool {
  factory: unknown;
  frameworkProvidedPaths: readonly (readonly string[])[];
  commandSpec: ExecCommandSpec;
  resultSchema: JSONSchema;
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

export function runtimeErrorLog(runtime: unknown): CliRuntimeErrorRecord[] {
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
  preparedFactory?: unknown,
): ExecCommandSpec {
  if (callableKind === "handler") {
    return {
      callableKind: "handler",
      defaultVerb: "invoke",
      inputSchema: callableCell.schema ?? true,
    };
  }

  const canonical = canonicalFactorySelection(callableCell);
  const schemaFactory = preparedFactory ?? canonical?.factory;
  const canonicalSchemas = schemaFactory === undefined
    ? undefined
    : patternFactorySchemas(schemaFactory);
  if (canonicalSchemas) {
    const frameworkProvidedPaths = getFrameworkProvidedPaths(schemaFactory);
    return {
      callableKind: "tool",
      defaultVerb: "run",
      inputSchema: stripFrameworkProvidedPaths(
        canonicalSchemas.argumentSchema,
        frameworkProvidedPaths,
      ),
      outputSchemaSummary: canonicalSchemas.resultSchema,
    };
  }

  throw new TypeError("Mounted tool requires a PatternFactory");
}

export async function prepareResolvedCallableTool(
  resolved: CallableResolution,
  deps: CallableExecutionDeps = {},
): Promise<PreparedCallableTool> {
  if (resolved.preparedTool) {
    if (!preparedCallableTools.has(resolved.preparedTool)) {
      throw new TypeError("Mounted tool preparation is not runner-owned");
    }
    return resolved.preparedTool;
  }
  if (resolved.callableKind !== "tool") {
    throw new TypeError("Only mounted tools have a factory to prepare");
  }

  const canonical = canonicalFactorySelection(resolved.callableCell);
  if (!canonical) throw new TypeError("Mounted tool requires a PatternFactory");
  if (!patternFactorySchemas(canonical.factory)) {
    throw new TypeError("Mounted tool requires a PatternFactory");
  }
  const sourceCell = canonical.leafCell.resolveAsCell?.() ?? canonical.leafCell;
  const artifactSpace = sourceCell.getAsNormalizedFullLink?.().space ??
    resolved.space;
  const factory = await (deps.prepareFactory ??
    ((factory, context) =>
      prepareFactory(factory, {
        runtime: context.runtime as unknown as Runtime,
        artifactSpace: context.artifactSpace as MemorySpace,
      })))(canonical.factory, {
      runtime: resolved.manager.runtime,
      artifactSpace,
    });
  const frameworkProvidedPaths = getFrameworkProvidedPaths(factory);
  const schemas = patternFactorySchemas(factory);
  if (!schemas) {
    throw new TypeError("Materialized tool is not a PatternFactory");
  }
  const prepared = {
    factory,
    frameworkProvidedPaths,
    commandSpec: callableCommandSpec(
      resolved.callableCell,
      "tool",
      factory,
    ),
    resultSchema: schemas.resultSchema,
  };
  preparedCallableTools.add(prepared);
  return prepared;
}

function callableStableEntityId(
  callableCell: CallableCellLike,
): string | undefined {
  let link;
  try {
    link = callableCell.getAsNormalizedFullLink?.();
  } catch {
    return undefined;
  }
  if (typeof link?.id !== "string" || link.id.length === 0) return undefined;
  try {
    const ref = getEntityId(linkRefFrom({
      id: link.id,
      ...(link.path && link.path.length > 0
        ? { path: link.path.map(String) }
        : {}),
    }));
    return ref && isEntityRef(ref) ? entityRefToString(ref) : undefined;
  } catch {
    return undefined;
  }
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

  const prepared = await prepareResolvedCallableTool(resolved, deps);
  const inputWithFrameworkValues = applyFrameworkProvidedInputs(
    normalizeToolInput(input),
    prepared.frameworkProvidedPaths,
    callableStableEntityId(resolved.identityCell ?? resolved.callableCell),
  );
  const runtime = resolved.manager.runtime;
  const runtimeErrors = runtimeErrorLog(runtime);
  const errorCountBefore = runtimeErrors.length;
  const tx = runtime.edit();
  const resultScope = resolved.callableCell.getAsNormalizedFullLink?.().scope;
  const resultCell = runtime.getCell(
    resolved.space,
    deps.uuid?.() ?? crypto.randomUUID(),
    prepared.resultSchema,
    tx,
    resultScope,
  );
  const running = runtime.run(
    tx,
    prepared.factory,
    inputWithFrameworkValues,
    resultCell,
  );
  // Capture the tool's result off its cell's sink. sink() fires immediately with
  // the current (initially undefined) value and re-fires on every committed
  // change, including the server-pushed writeback of an async tool's result.
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
    await runtime.idle();
    runtime.prepareTxForCommit?.(tx);
    if (typeof tx.commit !== "function") {
      throw new Error("Callable runtime transaction is not committable");
    }
    await tx.commit();

    // Drain the tool to a fully settled state — scheduler idle, storage synced,
    // and every in-flight async builtin finished — so the result is final by the
    // time we read it. A synchronous tool has already written its result; an
    // async tool's LLM/fetch call is awaited to completion here, with no poll
    // interval under it and no deadline over it. `settled()` normalizes a failed
    // builtin to "settled", so a broken tool converges here rather than hanging.
    if (typeof runtime.settled === "function") {
      await runtime.settled();
    } else {
      await runtime.idle();
      await resolved.manager.synced();
      await runtime.storageManager?.synced();
    }

    if (hasSinkValue) {
      outputValue = sinkValue;
    } else {
      // Fully settled with nothing on the sink: read once (a server-pushed value
      // can land without re-triggering the local effect).
      outputValue = typeof resultCell.pull === "function"
        ? await resultCell.pull()
        : resultCell.get();
      if (outputValue === undefined) {
        // The tool ran to a fully settled state without producing a result.
        // Keep the caller's contract of a defined result or an explicit
        // failure: surface the runtime error the pattern recorded when there
        // is one, and otherwise fail loudly rather than emitting nothing.
        const latestError = runtimeErrors.slice(errorCountBefore).at(-1)
          ?.message;
        throw new Error(
          latestError !== undefined
            ? `Tool "${resolved.cellKey}" failed: ${latestError}`
            : `Tool "${resolved.cellKey}" produced no result.`,
        );
      }
    }
  } finally {
    cancelSink?.();
  }

  return {
    outputText: JSON.stringify(outputValue, null, 2),
  };
}
