import type { MemorySpace } from "@commonfabric/memory/interface";
import { isRecord } from "@commonfabric/utils/types";
import { getTopFrame } from "../builder/pattern.ts";
import { type Frame, TYPE } from "../builder/types.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
} from "../query-result-proxy.ts";
import type { ErrorHandler, ErrorWithContext } from "../runtime.ts";
import type { IMemorySpaceAddress } from "../storage/interface.ts";
import type {
  ActionRunTraceAddress,
  DirtyDependencyTraceContext,
  TriggerTraceValueSummary,
} from "./types.ts";

export function createDirtyDependencyTraceContext(): DirtyDependencyTraceContext {
  return {
    visitCount: 0,
    memoHitCount: 0,
    cycleHitCount: 0,
    dirtyInputCount: 0,
    resultTrueCount: 0,
    workSetAddCount: 0,
    reverseDependencyActionCount: 0,
    reverseDependencyEdgeCount: 0,
    logFallbackCount: 0,
    logReadCount: 0,
    logShallowReadCount: 0,
    writerCandidateCount: 0,
    writerOverlapCount: 0,
    directWriterCount: 0,
    maxDepth: 0,
    depth: 0,
    actionSummaries: new Map(),
    rootDirectWriterActions: new Set(),
  };
}

export function toActionRunTraceAddress(
  address: IMemorySpaceAddress,
): ActionRunTraceAddress {
  return {
    space: address.space,
    entityId: address.id,
    path: address.path.map((part) => String(part)),
  };
}

export function summarizeTriggerTraceValue(
  value: unknown,
): TriggerTraceValueSummary {
  if (value === undefined) return { kind: "undefined" };
  if (value === null) return { kind: "null", preview: null };
  if (typeof value === "boolean") return { kind: "boolean", preview: value };
  if (typeof value === "number") return { kind: "number", preview: value };
  if (typeof value === "string") {
    return {
      kind: "string",
      size: value.length,
      preview: value.length > 80 ? `${value.slice(0, 77)}...` : value,
    };
  }
  if (Array.isArray(value)) {
    return { kind: "array", size: value.length };
  }
  if (isRecord(value)) {
    return { kind: "object", size: Object.keys(value).length };
  }
  return { kind: "other", preview: Object.prototype.toString.call(value) };
}

export function getPieceMetadataFromFrame(frame?: Frame): {
  spellId?: string;
  patternId?: string;
  space?: string;
  pieceId?: string;
} {
  // TODO(seefeld): This is a rather hacky way to get the context, based on the
  // unsafe_binding pattern. Once we replace that mechanism, let's add nicer
  // abstractions for context here as well.
  frame ??= getTopFrame();

  const sourceAsProxy = frame?.unsafe_binding?.materialize([]);

  if (!isCellResultForDereferencing(sourceAsProxy)) {
    return {};
  }
  const result: ReturnType<typeof getPieceMetadataFromFrame> = {};
  const source = getCellOrThrow(sourceAsProxy).asSchema({
    type: "object",
    properties: {
      [TYPE]: { type: "string" },
      spell: { type: "object", asCell: ["cell"] },
      resultRef: { type: "object", asCell: ["cell"] },
    },
  });
  result.patternId = source.get()?.[TYPE];
  const spellCell = source.get()?.spell;
  result.spellId = spellCell?.getAsNormalizedFullLink().id;
  const resultCell = source.get()?.resultRef;
  result.space = source.space;
  result.pieceId = resultCell?.entityId?.["/"];
  return result;
}

export function materializeHostVisibleStack(error: Error): void {
  if (typeof error.stack === "string" && error.stack.length > 0) {
    return;
  }
  const getStackString = (globalThis as {
    getStackString?: (error: Error) => string;
  }).getStackString;
  if (typeof getStackString !== "function") {
    return;
  }
  const frames = getStackString(error);
  if (!frames) {
    return;
  }
  error.stack = `${error}${frames.startsWith("\n") ? frames : `\n${frames}`}`;
}

export function handleSchedulerError(
  state: {
    readonly errorHandlers: ReadonlySet<ErrorHandler>;
    readonly parseStack: (stack: string) => string;
  },
  error: Error,
  action: unknown,
): void {
  const { pieceId, spellId, patternId, space } = getPieceMetadataFromFrame(
    (error as Error & { frame?: Frame }).frame,
  );

  // Transform stack trace to show original source locations.
  materializeHostVisibleStack(error);
  if (error.stack) {
    error.stack = state.parseStack(error.stack);
  }

  const errorWithContext = error as ErrorWithContext;
  errorWithContext.action = action as ErrorWithContext["action"];
  if (pieceId) errorWithContext.pieceId = pieceId;
  if (spellId) errorWithContext.spellId = spellId;
  if (patternId) errorWithContext.patternId = patternId;
  if (space) errorWithContext.space = space as MemorySpace;

  for (const handler of state.errorHandlers) {
    try {
      handler(errorWithContext);
    } catch (handlerError) {
      console.error("Error in error handler:", handlerError);
    }
  }

  const prefix = state.errorHandlers.size === 0
    ? "Uncaught error in action:"
    : "Error in action:";

  console.error(
    prefix,
    String(error),
    ...(pieceId ? [`\n  pieceId: ${pieceId}`] : []),
    ...(space ? [`\n  space: ${space}`] : []),
    ...(patternId ? [`\n  patternId: ${patternId}`] : []),
    ...(error.stack ? [`\n${error.stack}`] : []),
  );
}

export function queueTask(fn: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(fn, 0);
}
