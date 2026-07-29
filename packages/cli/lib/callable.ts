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
import { isRecord } from "@commonfabric/utils/types";
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
  /** The handling's receipt address (runner: tx.handlingReceiptLink) — on
   * success this handling's outcome, on a receipt-exists collision the
   * winner's original (verb contract WS-D). */
  handlingReceiptLink?: {
    id: string;
    space: string;
    scope?: CellScope;
    path?: readonly (string | number)[];
  };
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
    sendOptions?: { eventId?: string },
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
  /** Open a cell at a normalized link — the receipt readback path. */
  getCellFromLink?: (
    link: NonNullable<CallableTransactionLike["handlingReceiptLink"]>,
    schema?: JSONSchema,
    tx?: CallableTransactionLike,
  ) => CallableCellLike;
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

/** The phases a handler invocation passes through, reported on early exit so
 * a caller knows whether a retry is pre- or post-dispatch (both are safe with
 * a caller-supplied id; the phase is diagnosis, not a safety gate). */
export type InvocationPhase =
  | "initial_sync"
  | "dispatched"
  | "committed"
  | "readback";

export interface CallableExecutionDeps {
  uuid?: () => string;
  prepareFactory?: (
    factory: unknown,
    context: { runtime: CallableRuntimeLike; artifactSpace: string },
  ) => Promise<unknown>;
  /** Caller-supplied idempotency key for handler sends: threads through as
   * the durable event id, so a retry of the same id collides on the
   * handling's create-only receipt and reads the original outcome back
   * (verb contract WS-D). The guarantee is at-most-once *commit*, not
   * at-most-once *execution* — a redelivered event re-runs the handler body
   * and loses the race for the receipt, so a verb whose body has effects
   * outside its transaction (an LLM call, a fetch) repeats those effects on
   * retry even though nothing commits twice. */
  invocationId?: string;
  /** Phase observer for early-exit reporting. */
  onPhase?: (phase: InvocationPhase) => void;
}

/** The outcome of a handler invocation made with a caller-supplied id. */
export interface InvocationOutcome {
  id: string;
  status: "settled";
  /** The verb's result read back from the handling's receipt, when the
   * receipt carried one (a reactive-bearing return, or a plain return under
   * the plainResultReceipts flag). Absent for value-less verbs. */
  result?: unknown;
  /** True when this call collided on the create-only receipt: the handling
   * did not commit again, and `result` is the ORIGINAL outcome. */
  deduplicated?: boolean;
}

/** Durable address of a tool's per-invocation result cell. The scope is part
 * of the address: reopening a user- or session-scoped cell without it
 * resolves the space-scoped instance — a different cell. */
export interface CallableResultRef {
  space: string;
  id: string;
  scope: CellScope;
}

export interface ExecutedCallable {
  outputText?: string;
  /** Present for handler sends carrying a caller-supplied invocation id. */
  invocation?: InvocationOutcome;
  /** The tool result cell's address, when the runtime exposes it — the handle
   * a caller can revisit later instead of re-running the tool (verb contract
   * Part 2, docs/plans/pattern-verb-contract.md). Handlers gain their
   * equivalent with the invocation protocol's caller-supplied ids. */
  resultRef?: CallableResultRef;
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
      const invocationId = deps.invocationId;
      deps.onPhase?.("dispatched");
      const tx = await new Promise<CallableTransactionLike>(
        (resolve, reject) => {
          try {
            send.call(
              resolved.callableCell,
              input,
              resolve,
              invocationId !== undefined
                ? { eventId: invocationId }
                : undefined,
            );
          } catch (error) {
            reject(error);
          }
        },
      );
      // Acknowledgment is transaction-local (verb contract, Settlement): the
      // commit callback above fires on THIS handling's final commit. Awaiting
      // runtime.idle()/manager.synced() here instead would hold an
      // already-committed write hostage to every derived recomputation it
      // triggered elsewhere in the graph.
      deps.onPhase?.("committed");

      const txStatus = tx?.status?.();
      const deduplicated = txStatus?.status === "error" &&
        (txStatus.error as { precondition?: string } | undefined)
            ?.precondition === "receipt-exists";
      if (txStatus?.status === "error" && !deduplicated) {
        const latestRuntimeError = runtimeErrors.slice(errorCountBefore).at(-1)
          ?.message;
        throw new Error(
          `Handler "${resolved.cellKey}" failed: ${
            latestRuntimeError ?? errorMessage(txStatus.error)
          }`,
        );
      }

      if (invocationId === undefined) return {};

      // Read the handling's outcome back off its receipt. On a receipt-exists
      // collision this is the ORIGINAL handling's receipt — same id, same
      // outcome, no re-execution — so a retry settles as a success.
      deps.onPhase?.("readback");
      let result: unknown;
      const link = tx?.handlingReceiptLink;
      const getCellFromLink = resolved.manager.runtime.getCellFromLink;
      if (link && typeof getCellFromLink === "function") {
        const receipt = getCellFromLink.call(resolved.manager.runtime, link);
        const value = typeof receipt.pull === "function"
          ? await receipt.pull()
          : receipt.get();
        // A value-less verb's receipt is an empty record — existence-only.
        if (
          value !== undefined &&
          !(isRecord(value) && Object.keys(value).length === 0)
        ) {
          result = value;
        }
      }

      return {
        invocation: {
          id: invocationId,
          status: "settled",
          ...(deduplicated ? { deduplicated: true } : {}),
          ...(result !== undefined ? { result } : {}),
        },
      };
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

  // The result cell's durable address rides along when the runtime exposes
  // it: today the cell is otherwise unlinked — reachable by nobody once this
  // process exits (a named defect in the verb-contract design). Handing the
  // address back is the smallest honest handle.
  const resultLink = resultCell.getAsNormalizedFullLink?.();
  return {
    outputText: JSON.stringify(outputValue, null, 2),
    ...(resultLink?.id && resultLink?.space
      ? {
        resultRef: {
          space: resultLink.space,
          id: resultLink.id,
          // Absent scope on a normalized link means the space scope.
          scope: resultLink.scope ?? "space",
        },
      }
      : {}),
  };
}
