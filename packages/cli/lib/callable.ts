import type { CellScope, JSONSchema } from "@commonfabric/api";
import { encodeJsonPointer } from "@commonfabric/runner";
import {
  localRefTarget,
  relaxDefaultedRequired,
  validateSchemaValue,
} from "@commonfabric/runner/cfc/schema-sanitization";
import {
  type CallableKind,
  classifyCallableEntry,
} from "../../fuse/callables.ts";
import type { ExecCommandSpec } from "./exec-schema.ts";

export const CF_RUNTIME_ERROR_LOG = Symbol.for("cf.cli.runtimeErrorLog");

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
  asSchemaFromLinks?: () => CallableCellLike;
  key: (segment: string) => CallableCellLike;
  pull?: () => Promise<unknown>;
  getAsNormalizedFullLink?: () => {
    scope?: CellScope;
    id?: string;
    space?: string;
    path?: readonly (string | number)[];
  };
  /** Resolve through stored links to the concrete backing cell (runner:
   * Cell.resolveAsCell). `getAsNormalizedFullLink` alone reports the cell's
   * own address — receipt id plus path — even where the stored value is a
   * link into another document; resolving first is what tells the two
   * apart. */
  resolveAsCell?: () => CallableCellLike;
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
  callableKind: CallableKind;
  cellKey: string;
  cellProp: "input" | "result";
  manager: CallableManagerLike;
  piece: CallablePieceLike;
  space: string;
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
  /** `--no-wait`: await this handling's transaction-local commit
   * acknowledgement, then return WITHOUT the receipt readback (sync + read).
   * The commit acknowledgement cannot be skipped: the handler executes in
   * THIS process's runtime, so exiting before the commit is acknowledged
   * would abandon the invocation un-executed — nothing durable would have
   * happened — not leave it settling elsewhere. What CAN be skipped is
   * fetching the outcome back, because a caller-supplied id keeps that
   * fetch available forever: a later same-id call deduplicates against the
   * create-only receipt and returns the original outcome (verb contract
   * D1/D3). Requires an `invocationId` — without one there is no receipt to
   * come back for — and only the handler send path supports it (a tool's
   * result is delivered by this process, not read back from a receipt). */
  skipReadback?: boolean;
  /** `--show-links`: annotate the Invocation JSON with a `links` dictionary
   * mapping result paths to their backing cell addresses (verb contract
   * WS-F, F2). Provenance rides BESIDE the value, never inline — an inline
   * marker cannot annotate a scalar, and a scalar can be its own doc — and
   * entries appear only for paths whose backing differs from their enclosing
   * document, so plain JSON inside one doc adds nothing. Rides the receipt
   * readback, which is why it cannot combine with `--no-wait`. */
  showLinks?: boolean;
}

/** A backing-cell address in an Invocation's `links` dictionary: the same
 * serialized shape as `CallableResultRef` (the CLI's existing cell-address
 * form), plus the path inside the backing document when the link points
 * below its root. */
export interface InvocationResultLink extends CallableResultRef {
  path?: (string | number)[];
}

/** The outcome of a handler invocation made with a caller-supplied id. */
export interface InvocationOutcome {
  id: string;
  /** `"settled"` once receipt readback completed. Otherwise the furthest
   * phase the caller chose to observe: `--no-wait` returns at `"committed"`
   * (commit acknowledged, readback skipped), and a caller-bounded wait
   * reports the phase its bound expired in. */
  status: "settled" | InvocationPhase;
  /** The verb's result read back from the handling's receipt, when the
   * receipt carried one (a reactive-bearing return, or a plain return under
   * the plainResultReceipts flag). Absent for value-less verbs. */
  result?: unknown;
  /** True when this call collided on the create-only receipt: the handling
   * did not commit again, and `result` is the ORIGINAL outcome. */
  deduplicated?: boolean;
  /** Under `--show-links` only: result paths mapped to their backing cell
   * addresses, provenance beside the value. The root `"/"` entry is the
   * receipt itself; other entries appear only where a path's backing
   * document differs from its enclosing one. */
  links?: Record<string, InvocationResultLink>;
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

function isSchemaObject(schema: JSONSchema | undefined): schema is Record<
  string,
  unknown
> {
  return typeof schema === "object" && schema !== null &&
    !Array.isArray(schema);
}

/**
 * A verb invocation rejected before dispatch because the supplied payload does
 * not satisfy the verb's declared event schema.
 *
 * Reported as a data error (stderr, exit 1) rather than a Cliffy usage error:
 * the flags parsed fine, the values they carry don't fit the verb.
 */
export class VerbInputValidationError extends Error {
  constructor(readonly verb: string, readonly detail: string) {
    super(`Invalid input for "${verb}": ${detail}`);
    this.name = "VerbInputValidationError";
  }
}

// `localRefTarget` and `relaxDefaultedRequired` live beside the runtime's
// own validator (`@commonfabric/runner/cfc/schema-sanitization`), so this
// gate and the server-side closed-world enforcement (C5) share one
// implementation of "what does a default satisfy" instead of drifting apart.

/**
 * Normalize an absent payload to `{}` where the verb's event schema — after
 * resolving a top-level local `$ref` (a stream's schema is often
 * `{ $ref: "#/$defs/X", asCell: ["stream"], $defs: {...} }`) — is an object
 * schema. Everything else passes through untouched: schema `undefined` /
 * `true`, boolean `false` (an absent payload must pass; a supplied one is
 * already refused), non-object schemas, and an unresolvable `$ref` (fail-open
 * on uncertainty — refuse only on proof).
 *
 * Why `{}` rather than refusing absence outright (settled 2026-07-30,
 * measured on #5147): the runtime materializes a property's `default` only
 * for a PRESENT object payload — a wholly absent event bypasses default
 * materialization entirely, the handler sees `undefined`, and the receipt
 * still spends the invocation id. Normalizing lets absence flow through the
 * same gate as any payload: `{}` fails the relaxed schema exactly when
 * top-level `required` survives `relaxDefaultedRequired` (refusal, id never
 * spent), and dispatching `{}` where every required property carries a
 * default makes the runtime fill those defaults in — where an absent event
 * would have delivered nothing.
 */
export function normalizeAbsentVerbPayload(
  input: unknown,
  schema: JSONSchema | undefined,
): unknown {
  if (input !== undefined) return input;
  if (!isSchemaObject(schema)) return input;
  const target = localRefTarget(schema, schema);
  if (!isSchemaObject(target)) return input;
  if (target.type !== "object" && !isSchemaObject(target.properties)) {
    return input;
  }
  return {};
}

/**
 * Reject a payload that cannot satisfy the verb's event schema, before it is
 * sent.
 *
 * Pre-dispatch is the only place this can be caught. The runner does not
 * reject a mismatched payload: `generateHandlerSchema` puts the event under
 * `$event` and requires only `$ctx`, so a payload that fails the event schema
 * reads back as `undefined` rather than making the argument invalid — the
 * handler body then runs with no event, writes its receipt, and the invocation
 * reports settled. Refusing here keeps that from consuming the idempotency
 * key: an id that was never dispatched is still spendable by the corrected
 * retry.
 *
 * An absent payload reaches this function only after
 * `normalizeAbsentVerbPayload`: against an object schema it arrives as `{}`
 * and is judged like any supplied payload; against everything else it stays
 * `undefined` and passes — `$event` is genuinely optional in the generated
 * handler schema, and value-less verbs are a supported shape.
 */
export function verbInputSchemaError(
  input: unknown,
  schema: JSONSchema | undefined,
): string | undefined {
  if (input === undefined) return undefined;
  if (schema === undefined || schema === true) return undefined;
  return validateSchemaValue(
    relaxDefaultedRequired(schema, schema, new Map()),
    input,
  );
}

/**
 * The shared pre-dispatch gate. Returns the input to dispatch — the caller's
 * own payload, or `{}` when an absent payload was normalized against an
 * object schema — and throws `VerbInputValidationError` when that input
 * cannot satisfy the schema. The absent-payload refusal says so explicitly:
 * "send a payload" has to read differently from "fix your payload".
 */
function assertVerbInputSatisfiesSchema(
  verb: string,
  input: unknown,
  schema: JSONSchema | undefined,
): unknown {
  const normalized = normalizeAbsentVerbPayload(input, schema);
  const detail = verbInputSchemaError(normalized, schema);
  if (detail !== undefined) {
    throw new VerbInputValidationError(
      verb,
      input === undefined
        ? `no payload was supplied, and this verb cannot run without one ` +
          `(${detail}) — send a payload`
        : detail,
    );
  }
  return normalized;
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

/** Normalize a receipt/backing link into the `links` dictionary's value
 * shape. Absent scope on a normalized link means the space scope (the same
 * rule `resultRef` applies); the path rides along only when the link points
 * below the backing document's root. */
function toInvocationResultLink(link: {
  id: string;
  space: string;
  scope?: CellScope;
  path?: readonly (string | number)[];
}): InvocationResultLink {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope ?? "space",
    ...(link.path !== undefined && link.path.length > 0
      ? { path: [...link.path] }
      : {}),
  };
}

/** Two normalized links address the same backing document iff id, space,
 * and scope (absent = space) all agree; a differing path alone is just a
 * position inside the same doc, which needs no link of its own. */
function sameBackingDocument(
  a: { id: string; space: string; scope?: CellScope },
  b: { id: string; space: string; scope?: CellScope },
): boolean {
  return a.id === b.id && a.space === b.space &&
    (a.scope ?? "space") === (b.scope ?? "space");
}

/**
 * Walk a settled result's backing links into the `{ "/path": <link> }`
 * dictionary `--show-links` emits (verb contract WS-F, F2).
 *
 * The root `"/"` entry is the receipt's own address. Below it, every value
 * path is resolved through the receipt cell (`key()` steps plus
 * `resolveAsCell`), and a path earns an entry exactly when its backing
 * document differs from its enclosing one — a path inside the same plain
 * JSON needs no link. Below an emitted entry the comparison rebases onto
 * that entry's document, so a chain of references annotates each hop once.
 * Keys are RFC 6901 JSON pointers (the runner's `encodeJsonPointer`, the
 * same encoding the llm-dialog link strings use), so a property name
 * containing `/` or `~` stays unambiguous.
 *
 * The walk covers the VALUE that was read back — finite, already-loaded
 * JSON — not the graph, so it terminates without cycle tracking, and a
 * receipt cell that cannot resolve links (no `resolveAsCell`) degrades to
 * the root entry alone rather than guessing.
 */
export function collectInvocationResultLinks(
  receiptLink: NonNullable<CallableTransactionLike["handlingReceiptLink"]>,
  receiptCell: CallableCellLike | undefined,
  value: unknown,
): Record<string, InvocationResultLink> {
  const links: Record<string, InvocationResultLink> = {
    "/": toInvocationResultLink(receiptLink),
  };
  if (receiptCell === undefined) return links;

  const walk = (
    cell: CallableCellLike,
    val: unknown,
    pathSegments: string[],
    base: { id: string; space: string; scope?: CellScope },
  ): void => {
    if (typeof val !== "object" || val === null) return;
    const keys = Array.isArray(val)
      ? val.map((_, index) => String(index))
      : Object.keys(val);
    for (const key of keys) {
      const childValue = (val as Record<string, unknown>)[key];
      let child: CallableCellLike;
      try {
        child = cell.key(key);
      } catch {
        continue; // Not addressable as a cell — nothing to annotate.
      }
      const resolved = child.resolveAsCell?.() ?? child;
      const childLink = resolved.getAsNormalizedFullLink?.();
      const segments = [...pathSegments, key];
      if (
        childLink?.id !== undefined && childLink.space !== undefined &&
        !sameBackingDocument(
          childLink as { id: string; space: string; scope?: CellScope },
          base,
        )
      ) {
        links[encodeJsonPointer(["", ...segments])] = toInvocationResultLink(
          childLink as {
            id: string;
            space: string;
            scope?: CellScope;
            path?: readonly (string | number)[];
          },
        );
        walk(
          resolved,
          childValue,
          segments,
          childLink as { id: string; space: string; scope?: CellScope },
        );
      } else {
        walk(child, childValue, segments, base);
      }
    }
  };

  walk(receiptCell, value, [], receiptLink);
  return links;
}

export async function executeResolvedCallable(
  resolved: CallableResolution,
  input: unknown,
  deps: CallableExecutionDeps = {},
): Promise<ExecutedCallable> {
  if (resolved.callableKind === "handler") {
    const send = resolved.callableCell.send;
    if (typeof send === "function") {
      // Before anything is dispatched, and so before the invocation id can be
      // spent on a handling that would run with no event. An absent payload
      // is normalized to `{}` against an object schema (D5), so what goes out
      // is what the gate judged.
      const dispatchInput = assertVerbInputSatisfiesSchema(
        resolved.cellKey,
        input,
        resolved.callableCell.schema,
      );
      const runtimeErrors = runtimeErrorLog(resolved.manager.runtime);
      const errorCountBefore = runtimeErrors.length;
      const invocationId = deps.invocationId;
      if (deps.skipReadback && invocationId === undefined) {
        // Refused before dispatch: skipping the readback is only sound when
        // a later same-id call can fetch the outcome, and that needs the id.
        throw new Error("--no-wait requires an invocation id");
      }
      deps.onPhase?.("dispatched");
      const tx = await new Promise<CallableTransactionLike>(
        (resolve, reject) => {
          try {
            send.call(
              resolved.callableCell,
              dispatchInput,
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

      if (deps.skipReadback) {
        // --no-wait's exit point: the commit is acknowledged, so the
        // handling — and on a collision, the original one — is durable on
        // the server and survives this process. Only the readback
        // (sync + read of the outcome) is skipped; a later same-id call
        // retrieves it by deduplicating against the create-only receipt.
        return {
          invocation: {
            id: invocationId,
            status: "committed",
            ...(deduplicated ? { deduplicated: true } : {}),
          },
        };
      }

      // Read the handling's outcome back off its receipt. On a receipt-exists
      // collision this is the ORIGINAL handling's receipt — same id, same
      // outcome, no re-execution — so a retry settles as a success.
      deps.onPhase?.("readback");
      let result: unknown;
      let links: Record<string, InvocationResultLink> | undefined;
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
        if (deps.showLinks) {
          // After readback, off the same receipt the result came from: the
          // links annotate exactly the value the caller is holding.
          links = collectInvocationResultLinks(link, receipt, result);
        }
      }

      return {
        invocation: {
          id: invocationId,
          status: "settled",
          ...(deduplicated ? { deduplicated: true } : {}),
          ...(result !== undefined ? { result } : {}),
          ...(links !== undefined ? { links } : {}),
        },
      };
    }

    if (deps.skipReadback) {
      // This handler dispatches through a plain data write, outside the
      // invocation receipt protocol — there is no per-handling commit
      // acknowledgement to wait for and no receipt a later same-id call
      // could read the outcome back from.
      throw new Error(
        `--no-wait is not available for "${resolved.cellKey}": ` +
          "this callable dispatches without an invocation receipt",
      );
    }
    await resolved.piece[resolved.cellProp].set(input, [resolved.cellKey]);
    await resolved.manager.runtime.idle();
    await resolved.manager.synced();

    return {};
  }

  if (deps.skipReadback) {
    // A tool's result is produced and delivered by this process, not read
    // back from a receipt — there is nothing to skip that a later call
    // could recover.
    throw new Error(
      `--no-wait is not available for tool "${resolved.cellKey}": ` +
        "a tool runs to completion in this process",
    );
  }

  const pattern = asCallablePattern(
    resolved.callableCell.key("pattern").getRaw?.() ??
      resolved.callableCell.key("pattern").get(),
  );
  const extraParams = asExtraParams(
    resolved.callableCell.key("extraParams").get?.(),
  );
  const runtime = resolved.manager.runtime;
  const runtimeErrors = runtimeErrorLog(runtime);
  const errorCountBefore = runtimeErrors.length;
  const tx = runtime.edit();
  const resultScope = resolved.callableCell.getAsNormalizedFullLink?.().scope;
  const resultCell = runtime.getCell(
    resolved.space,
    deps.uuid?.() ?? crypto.randomUUID(),
    pattern?.resultSchema,
    tx,
    resultScope,
  );
  const running = runtime.run(
    tx,
    pattern,
    mergeToolInput(input, extraParams),
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
