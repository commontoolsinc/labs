import type { CellScope, JSONSchema } from "@commonfabric/api";
import {
  type CallableKind,
  classifyCallableEntry,
} from "../../fuse/callables.ts";
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
  asSchemaFromLinks?: () => CallableCellLike;
  key: (segment: string) => CallableCellLike;
  pull?: () => Promise<unknown>;
  getAsNormalizedFullLink?: () => { scope?: CellScope };
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
}

export interface ExecutedCallable {
  outputText?: string;
}

interface CallablePatternLike extends Record<string, unknown> {
  argumentSchema?: JSONSchema;
  resultSchema?: JSONSchema;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function asCallablePattern(value: unknown): CallablePatternLike | undefined {
  if (!isRecord(value)) return undefined;
  return value as CallablePatternLike;
}

function asExtraParams(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
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
  let resolvedValue = callableValue;
  try {
    resolvedValue = callableCell?.getRaw?.() ?? callableCell?.get?.() ??
      callableValue;
  } catch {
    resolvedValue = callableValue;
  }

  const callableKind =
    classifyCallableEntry(callableValue, callableCell?.schema) ??
      classifyCallableEntry(resolvedValue, callableCell?.schema) ??
      classifyCallableEntry(callableCell, callableCell?.schema);
  if (callableKind) {
    return callableKind;
  }

  try {
    const pattern = callableCell.key("pattern").getRaw?.() ??
      callableCell.key("pattern").get?.();
    const extraParams = callableCell.key("extraParams").get?.();
    if (pattern !== undefined && extraParams !== undefined) {
      return "tool";
    }
  } catch {
    // Not a tool-shaped callable cell.
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

  const pattern = asCallablePattern(
    callableCell.key("pattern").getRaw?.() ??
      callableCell.key("pattern").get(),
  );
  const extraParams = asExtraParams(
    callableCell.key("extraParams").get?.(),
  );

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

  const pattern = asCallablePattern(
    resolved.callableCell.key("pattern").getRaw?.() ??
      resolved.callableCell.key("pattern").get(),
  );
  const extraParams = asExtraParams(
    resolved.callableCell.key("extraParams").get?.(),
  );
  const tx = resolved.manager.runtime.edit();
  const resultScope = resolved.callableCell.getAsNormalizedFullLink?.().scope;
  const resultCell = resolved.manager.runtime.getCell(
    resolved.space,
    deps.uuid?.() ?? crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
    resultScope,
  );
  const running = resolved.manager.runtime.run(
    tx,
    pattern,
    mergeToolInput(input, extraParams),
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
