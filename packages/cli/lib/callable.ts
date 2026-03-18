import type { JSONSchema } from "@commontools/api";
import {
  type CallableKind,
  classifyCallableEntry,
} from "../../fuse/callables.ts";
import type { ExecCommandSpec } from "./exec-schema.ts";

export interface CallableResolution {
  callableCell: any;
  callableKind: CallableKind;
  cellKey: string;
  cellProp: "input" | "result";
  manager: any;
  piece: any;
  space: string;
}

export interface CallableExecutionDeps {
  timeoutMs?: number;
  uuid?: () => string;
  waitForResult?: (resultCell: any, timeoutMs: number) => Promise<unknown>;
}

export interface ExecutedCallable {
  outputText?: string;
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

export function detectCallableKind(
  callableValue: unknown,
  callableCell: any,
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
      classifyCallableEntry(resolvedValue, callableCell?.schema);
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
  callableCell: any,
  callableKind: CallableKind,
): ExecCommandSpec {
  if (callableKind === "handler") {
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

export async function executeResolvedCallable(
  resolved: CallableResolution,
  input: unknown,
  deps: CallableExecutionDeps = {},
): Promise<ExecutedCallable> {
  if (resolved.callableKind === "handler") {
    await resolved.piece[resolved.cellProp].set(
      input,
      [resolved.cellKey],
    );
    await resolved.manager.runtime.idle();
    await resolved.manager.synced();

    return {};
  }

  const pattern = resolved.callableCell.key("pattern").getRaw?.() ??
    resolved.callableCell.key("pattern").get();
  const extraParams = resolved.callableCell.key("extraParams").get() ?? {};
  const tx = resolved.manager.runtime.edit();
  const resultCell = resolved.manager.runtime.getCell(
    resolved.space,
    deps.uuid?.() ?? crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
  );
  const running = resolved.manager.runtime.run(
    tx,
    pattern,
    mergeToolInput(input, extraParams),
    resultCell,
  );
  const cancelSink = typeof running?.sink === "function"
    ? running.sink(() => {})
    : undefined;

  let outputValue: unknown;
  try {
    await tx.commit();
    await resolved.manager.runtime.idle();
    await resolved.manager.synced();

    outputValue = await (deps.waitForResult ?? defaultWaitForResult)(
      resultCell,
      deps.timeoutMs ?? 5000,
    );
  } finally {
    cancelSink?.();
  }

  return {
    outputText: JSON.stringify(outputValue, null, 2),
  };
}
