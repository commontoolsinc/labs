import type { CellScope, JSONSchema, Pattern } from "@commonfabric/api";
import type { PiecesController } from "@commonfabric/piece/ops";
import {
  type Cell,
  encodeJsonPointer,
  type IExtendedStorageTransaction,
  type MemorySpace,
  type NormalizedFullLink,
} from "@commonfabric/runner";
import { isInstance } from "@commonfabric/utils/types";
import {
  localRefTarget,
  relaxDefaultedRequired,
  validateSchemaValue,
} from "@commonfabric/runner/cfc/schema-sanitization";
import {
  type CallableKind,
  classifyCallableEntry,
} from "../../fuse/callables.ts";
import {
  boundReadValue,
  type CellSelection,
  CellSelectionError,
  deriveSelectedValue,
} from "./cell-selection.ts";
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

export interface CallableResolution {
  callableCell: Cell<any>;
  callableKind: CallableKind;
  cellKey: string;
  pieces: PiecesController;
  space: MemorySpace;
  /** This verb's declared result, resolved on demand.
   *
   * A THUNK rather than a value, because reaching it costs a pattern load and
   * almost no call needs it. Two callers do: `--help`, which enumerates what a
   * verb hands back, and a readback whose value closes a circle, which bounds
   * itself with the declaration rather than failing. A readback that renders
   * asks nothing of it, so an ordinary dispatch still loads no pattern.
   *
   * Absent where the resolution cannot match a declaration to the verb — a
   * handler reached on the piece's input cell, a piece surface with no pattern
   * to consult — which says this resolution cannot describe a result rather
   * than promising there is none. */
  declaredResult?: () => Promise<JSONSchema | undefined>;
  /** The verb's published event schema, when the resolution knows a richer
   * one than the dispatch cell carries.
   *
   * The forced-stream fallback dispatches through a cast cell whose schema is
   * only `{asCell: ["stream"]}` — a shape every payload satisfies — while the
   * link-derived cell still carries whatever payload schema the piece
   * publishes. The pre-dispatch gate validates against this when present, so
   * a malformed payload on that path is refused before the invocation id is
   * spent, exactly as on the ordinary paths. */
  inputSchema?: JSONSchema;
}

/** The phases a handler invocation passes through, reported on early exit so
 * a caller knows whether a retry is pre- or post-dispatch (both are safe with
 * a caller-supplied id; the phase is diagnosis, not a safety gate). */
export type InvocationPhase =
  | "initial_sync"
  | "dispatched"
  | "committed"
  | "readback";

/**
 * What names one handler invocation: the caller's idempotency key for a
 * dispatch, and the session that key was chosen within (`newSessionId`,
 * ./session.ts).
 *
 * The two travel as a pair because an id is the caller's own word — an agent
 * picks `add-comment-1` — and another caller can pick the same one. The pair
 * reaches the durable event id, so a retry naming both collides on the
 * handling's create-only receipt and reads the original outcome back (verb
 * contract WS-D), while the same id under another session is a different
 * invocation entirely.
 *
 * The guarantee is at-most-once *commit*, not at-most-once *execution* — a
 * redelivered event re-runs the handler body and loses the race for the
 * receipt, so a verb whose body has effects outside its transaction (an LLM
 * call, a fetch) repeats those effects on retry even though nothing commits
 * twice.
 */
export interface InvocationIdentity {
  id: string;
  session: string;
}

export interface CallableExecutionDeps {
  uuid?: () => string;
  /** The id and session naming this call's invocation, for a handler send.
   * Absent for a call that names no invocation, which is then dispatched
   * under a runtime-minted event id and has no receipt to come back for. */
  invocation?: InvocationIdentity;
  /** Phase observer for early-exit reporting. */
  onPhase?: (phase: InvocationPhase) => void;
  /** `--no-wait`: await this handling's transaction-local commit
   * acknowledgement, then return WITHOUT the receipt readback (sync + read).
   * The commit acknowledgement cannot be skipped: the handler executes in
   * THIS process's runtime, so exiting before the commit is acknowledged
   * would abandon the invocation un-executed — nothing durable would have
   * happened — not leave it settling elsewhere. What CAN be skipped is
   * fetching the outcome back, because the exit publishes the receipt's
   * address (`InvocationOutcome.receipt`), so collecting it later is an
   * ordinary read; a same-id replay recovers it too, deduplicating against
   * the create-only receipt (verb contract D1/D3), but re-runs the handler
   * body. Requires an `invocationId` — without one there is no receipt to
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
  /** `--filter`/`--select`/`--schema`: the shape the caller asked the result
   * to arrive in. Answered by the same selection step `cf piece get` reads
   * through, so one grammar covers reads and calls.
   *
   * It shapes a result that exists rather than deciding what is fetched: the
   * readback has already materialized the whole receipt by the time this
   * applies, and a receipt declares no schema for a selector to narrow
   * against. A verb that returns nothing keeps returning nothing — there is
   * no value for a selection to be about. */
  selection?: CellSelection;
  /** @internal Seam for tests, mirroring `getCellValue`'s. */
  deriveSelectedValue?: typeof deriveSelectedValue;
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
  /** Durable address of this handling's receipt — the cell the outcome is
   * written to, and the one `result` is read from.
   *
   * Published from the transaction's handling receipt link, which the commit
   * callback carries, so the address is known BEFORE the outcome is read.
   * That is what makes it available under `--no-wait`: a caller that chose
   * not to wait still holds the address to collect from, and reads it back
   * with `cf piece get --piece <id>` rather than re-invoking the verb. The
   * receipt is a COMMIT witness, not an execution witness — a same-id replay
   * runs the handler body again and then loses the race, so effects outside
   * the transaction repeat.
   *
   * On a create-only collision this addresses the ORIGINAL handling's
   * receipt: the loser's commit callback carries the winner's address. That
   * is the runner's guarantee, asserted where it is implemented
   * (`packages/runner/test/scheduler-event-receipts.test.ts`, "cell.send
   * carries a caller-supplied eventId and exposes the receipt link") — the
   * CLI's own tests drive a single address and cannot witness it.
   *
   * Absent when the runtime published no link: with `commitPreconditions`
   * off nothing writes a receipt, and an address naming a cell that does not
   * exist is worse than no address. */
  receipt?: InvocationResultLink;
  /** The verb's result read back from the handling's receipt, when the
   * receipt carried one (a reactive-bearing return, or a plain return under
   * the plainResultReceipts flag). Absent for value-less verbs. */
  result?: unknown;
  /** True when this call collided on the create-only receipt: the handling
   * did not commit again, and `result` is the ORIGINAL outcome. */
  deduplicated?: boolean;
  /** Under `--show-links` only: result paths mapped to their backing cell
   * addresses, provenance beside the value. The root `"/"` entry is the
   * result value's own backing document — the receipt, unless the result is
   * itself a reference, in which case the receipt address rides the
   * reserved bare `"receipt"` key; other entries appear only where a path's
   * backing document differs from its enclosing one. */
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
  /** The tool result cell's address — the handle a caller can revisit later
   * instead of re-running the tool (verb contract Part 2,
   * docs/plans/pattern-verb-contract.md). Handlers gain their equivalent with
   * the invocation protocol's caller-supplied ids. */
  resultRef?: CallableResultRef;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Read a tool callable's stored `pattern` slot as the pattern the runner
 * will run. Only the record shape is checked here; a record missing the
 * schemas reaches `runtime.run` the same way any malformed stored pattern
 * does. */
function asCallablePattern(value: unknown): Pattern | undefined {
  if (!isRecord(value)) return undefined;
  return value as Pattern;
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
  if (
    typeof error === "object" && error !== null && "reason" in error &&
    (error as { reason?: unknown }).reason != null
  ) {
    // A StorageTransactionAborted carries the abort's cause as `reason`, and
    // its own message is the generic "Transaction was aborted". Prefer the
    // cause: for a pre-dispatch drop — a send refused at the backlog cap, a
    // piece that failed to load — the reason is the whole signal.
    return errorMessage((error as { reason: unknown }).reason);
  }
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
 * schema: directly object-shaped, or an `allOf` conjunction with an
 * object-schema branch (see `schemaIsObjectShaped`; `anyOf`/`oneOf` roots
 * stay untouched). Everything else passes through untouched: schema
 * `undefined` / `true`, boolean `false` (an absent payload must pass; a
 * supplied one is already refused), non-object schemas, and an unresolvable
 * `$ref` (fail-open on uncertainty — refuse only on proof).
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
  if (!schemaIsObjectShaped(target, schema)) return input;
  return {};
}

/**
 * Whether a resolved event schema describes an object payload — directly, or
 * as an `allOf` conjunction with an object-schema branch (a conjunction that
 * includes an object schema IS an object schema, no branch choice involved).
 * `anyOf`/`oneOf` roots deliberately return false: normalizing `{}` there
 * would pick among alternatives on the caller's behalf, the combinator
 * boundary the D5 rule records (refuse or normalize only on proof) — the
 * plan's D5 bullet names disjunctive roots out of scope.
 */
export function schemaIsObjectShaped(
  target: JSONSchema,
  root: JSONSchema,
): boolean {
  if (!isSchemaObject(target)) return false;
  if (target.type === "object" || isSchemaObject(target.properties)) {
    return true;
  }
  if (Array.isArray(target.allOf)) {
    return target.allOf.some((branch) => {
      const resolved = localRefTarget(branch, root);
      return isSchemaObject(resolved) &&
        (resolved.type === "object" || isSchemaObject(resolved.properties));
    });
  }
  return false;
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
  callableCell: Cell<any>,
): CallableKind | null {
  let resolvedValue = callableValue;
  try {
    resolvedValue = callableCell.getRaw() ?? callableCell.get() ??
      callableValue;
  } catch {
    resolvedValue = callableValue;
  }

  const callableKind =
    classifyCallableEntry(callableValue, callableCell.schema) ??
      classifyCallableEntry(resolvedValue, callableCell.schema) ??
      classifyCallableEntry(callableCell, callableCell.schema);
  if (callableKind) {
    return callableKind;
  }

  try {
    const pattern = callableCell.key("pattern").getRaw() ??
      callableCell.key("pattern").get();
    const extraParams = callableCell.key("extraParams").get();
    if (pattern !== undefined && extraParams !== undefined) {
      return "tool";
    }
  } catch {
    // Not a tool-shaped callable cell.
  }

  return null;
}

export function callableCommandSpec(
  callableCell: Cell<any>,
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
    callableCell.key("pattern").getRaw() ??
      callableCell.key("pattern").get(),
  );
  const extraParams = asExtraParams(
    callableCell.key("extraParams").get(),
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
 * shape. The path rides along only when the link points below the backing
 * document's root. */
function toInvocationResultLink(
  link: NormalizedFullLink,
): InvocationResultLink {
  return {
    space: link.space,
    id: link.id,
    scope: link.scope,
    ...(link.path.length > 0 ? { path: [...link.path] } : {}),
  };
}

/** Two normalized links address the same backing document iff id, space,
 * and scope all agree; a differing path alone is just a position inside the
 * same doc, which needs no link of its own. */
function sameBackingDocument(
  a: NormalizedFullLink,
  b: NormalizedFullLink,
): boolean {
  return a.id === b.id && a.space === b.space && a.scope === b.scope;
}

/**
 * Walk a settled result's backing links into the `{ "/path": <link> }`
 * dictionary `--show-links` emits (verb contract WS-F, F2).
 *
 * The root `"/"` entry is the backing document of the result VALUE itself,
 * resolved through `resolveAsCell` like every other path — the design's own
 * motivating case is a result that is a reference (a scalar can be its own
 * doc), and `"/"` must expose the document that actually backs it, not the
 * cell it was read through. In the common case the root resolves to the
 * receipt and `"/"` IS the receipt address; when it resolves elsewhere, the
 * receipt address stays available under the reserved bare key `"receipt"` —
 * pointer keys always begin with `/`, so no result path can collide with
 * it.
 *
 * Below the root, every value path is resolved through the receipt cell
 * (`key()` steps plus `resolveAsCell`), and a path earns an entry exactly
 * when its backing document differs from its enclosing one — a path inside
 * the same plain JSON needs no link. Below an emitted entry the comparison
 * rebases onto that entry's document, so a chain of references annotates
 * each hop once. Recursion always continues from the RESOLVED cell, even
 * when no entry is emitted: a same-document link can still redirect to
 * another path, and descendants must be read from the redirect's target.
 * Keys are RFC 6901 JSON pointers (the runner's `encodeJsonPointer`, the
 * same encoding the llm-dialog link strings use), so a property name
 * containing `/` or `~` stays unambiguous.
 *
 * The walk covers the JSON of the value that was read back, and it ENFORCES
 * that rather than assuming it: descent stops at any non-plain object —
 * including a result that is itself one — so a live runtime object reached
 * through the result contributes its own link and nothing below it. That
 * bound is what makes the walk terminate. A result carrying a piece that
 * owns verbs is the case that proves the point — the stream on that piece is
 * a live object whose `runtime`/`scheduler` graph refers back to itself, and
 * walking into it exhausted the stack.
 */
export function collectInvocationResultLinks(
  receiptLink: NormalizedFullLink,
  receiptCell: Cell<any>,
  value: unknown,
): Record<string, InvocationResultLink> {
  const resolvedRoot = receiptCell.resolveAsCell();
  const rootBacking = resolvedRoot.getAsNormalizedFullLink();
  const links: Record<string, InvocationResultLink> = {
    "/": toInvocationResultLink(rootBacking),
  };
  if (!sameBackingDocument(rootBacking, receiptLink)) {
    links["receipt"] = toInvocationResultLink(receiptLink);
  }

  const walk = (
    cell: Cell<any>,
    val: unknown,
    pathSegments: string[],
    base: NormalizedFullLink,
  ): void => {
    // A non-plain object is not part of the result's JSON: it is a live
    // runtime object the readback surfaced (a stream on a returned piece,
    // most commonly). It keeps the entry its parent emitted — the root's
    // "/" when the result itself is live — but the walk never goes inside:
    // its properties are the runtime's, not the result's, and they refer
    // back to themselves.
    if (typeof val !== "object" || val === null || isInstance(val)) return;
    const keys = Array.isArray(val)
      ? val.map((_, index) => String(index))
      : Object.keys(val);
    for (const key of keys) {
      const childValue = (val as Record<string, unknown>)[key];
      let child: Cell<any>;
      try {
        child = cell.key(key);
      } catch {
        continue; // Not addressable as a cell — nothing to annotate.
      }
      const resolved = child.resolveAsCell();
      const childLink = resolved.getAsNormalizedFullLink();
      const segments = [...pathSegments, key];
      if (!sameBackingDocument(childLink, base)) {
        links[encodeJsonPointer(["", ...segments])] = toInvocationResultLink(
          childLink,
        );
        walk(resolved, childValue, segments, childLink);
      } else {
        // Same backing document — no entry — but descendants are still read
        // from the RESOLVED cell: a same-doc link can redirect to another
        // path, and the children live under its target.
        walk(resolved, childValue, segments, base);
      }
    }
  };

  walk(resolvedRoot, value, [], rootBacking);
  return links;
}

/**
 * Shape a call's result the way the caller asked for it, through the same step
 * `cf piece get` reads through — the one place a `--filter`/`--select`/
 * `--schema` grammar is interpreted, so a caller learns it once.
 *
 * `resultCell` is the cell the value was produced from: a handling's receipt,
 * or a tool's result cell. The step reads through it and therefore reports the
 * source's own links and Fabric metadata, which is what makes an address a
 * caller can act on come back rather than a copy.
 *
 * A selection that materializes nothing over a result that exists is refused
 * rather than reported as an absent result: an omitted `result` key means the
 * verb returned nothing, and a projection that kept nothing is a different
 * fact. `cf piece get` refuses the same condition on the same grounds.
 */
async function selectCallResult(
  resolved: CallableResolution,
  resultCell: Cell<any>,
  selection: CellSelection,
  deps: CallableExecutionDeps,
): Promise<unknown> {
  const selected = await (deps.deriveSelectedValue ?? deriveSelectedValue)(
    resolved.pieces.runtime,
    resolved.space,
    resultCell,
    selection,
  );
  if (selected === undefined) {
    throw new CellSelectionError(
      `Cannot shape the result of "${resolved.cellKey}": the filter/schema ` +
        "expression did not materialize a JSON-renderable value. This is " +
        "not JSON null, and it is not the empty receipt a value-less verb " +
        "settles with — inspect the result and the selection.",
    );
  }
  return selected;
}

/**
 * A result that cannot be written as JSON because it closes a circle, and that
 * nothing in reach bounds: the verb declared no result, or the declaration it
 * did make leaves the closing position unbounded.
 *
 * A distinct type because the condition is a rendering failure over a handling
 * that COMMITTED, which is the one thing the message has to carry — the caller
 * is holding a nonzero exit for a mutation that landed.
 */
export class CyclicResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CyclicResultError";
  }
}

/**
 * Helper for {@link circularResultPath}: the position, as a JSON pointer, that
 * is reachable from inside itself.
 *
 * Ancestors, not visits: a value reachable by two paths is written twice and
 * renders fine, while a value reachable from inside itself has no rendering at
 * all. Own enumerable keys and nothing else, which is what a serializer reads.
 *
 * A node carrying `toJSON` is a leaf here, because it is a leaf to the
 * serializer too: what gets written is whatever that method returns, and the
 * properties underneath are never visited. The runtime objects a readback
 * surfaces — a stream on a returned piece — are exactly that case, and their
 * internals do refer back to themselves.
 */
function locateResultCycle(value: unknown): string | undefined {
  const ancestors = new Set<object>();
  const walk = (node: unknown, path: string[]): string | undefined => {
    if (typeof node !== "object" || node === null) return undefined;
    if (ancestors.has(node)) return encodeJsonPointer(["", ...path]);
    if (typeof (node as { toJSON?: unknown }).toJSON === "function") {
      return undefined;
    }
    ancestors.add(node);
    try {
      const keys = Array.isArray(node)
        ? node.map((_, index) => String(index))
        : Object.keys(node);
      for (const key of keys) {
        const found = walk(
          (node as Record<string, unknown>)[key],
          [...path, key],
        );
        if (found !== undefined) return found;
      }
      return undefined;
    } finally {
      ancestors.delete(node);
    }
  };
  return walk(value, []);
}

/**
 * The JSON pointer of the position where `value` closes a circle, or
 * `undefined` where `value` can be written as JSON.
 *
 * Two witnesses have to agree before this reports one. The serializer decides
 * whether the value renders at all — it is the thing whose failure is being
 * prevented, so nothing else gets to overrule it — and the walk beside it
 * decides where. A value the serializer writes is left alone whatever the walk
 * thinks, and a serializer failure the walk cannot place is left alone too:
 * `JSON.stringify` refuses more than circles, and a refusal that is not one is
 * not this path's to answer.
 */
function circularResultPath(value: unknown): string | undefined {
  try {
    JSON.stringify(value);
    return undefined;
  } catch {
    return locateResultCycle(value);
  }
}

/**
 * Bound a readback that closes a circle with the verb's own declared result,
 * and hand back the value that bounds to.
 *
 * The declaration is the boundary the AUTHOR drew: the position where the
 * declared type re-enters itself is the position that closes the circle, so
 * rendering an address there cuts exactly where the shape says it should, and
 * leaves every other position reading as it already did. The addresses are
 * written by the same walk `--select`/`--schema` compose theirs with, so a
 * derived bound and a hand-written one name the same position the same way.
 *
 * The cut is applied to `value` — the result already in hand — and never reads
 * a second one. That is what lets it bound a result a caller ALREADY shaped
 * without widening it: a projection can name the re-entering subtree whole,
 * which selects the circle rather than cutting past it, and the cut then
 * removes the closing position from what they selected rather than answering
 * with the declaration's whole shape in its place. Where a caller's own shape
 * renders, this is never reached at all.
 *
 * Refuses where nothing in reach bounds it: no declaration at all, a
 * declaration whose recursion does not reach the closing position, or a
 * `--filter` beside it — a filtered array's elements no longer say which
 * positions they came from, and the bound is written in addresses, which name
 * positions. A refusal names where the circle closes and how to collect the
 * outcome, which beats a stack trace for a handling that already committed.
 */
async function boundCyclicResult(
  resolved: CallableResolution,
  receiptCell: Cell<any>,
  value: unknown,
  cycle: string,
  receiptId: string | undefined,
  deps: CallableExecutionDeps,
): Promise<unknown> {
  // Each wording is its own statement, so a reader of the coverage report can
  // tell which of them a test has ever produced. Inside one expression they
  // could not: a ternary is a single statement, and its untaken arm is
  // credited with the count of the statement holding it, so a wording nothing
  // has ever emitted reads exactly like one every call emits.
  let whyUnbounded: string;
  if (deps.selection?.filter !== undefined) {
    // Decided before the declaration is reached for, because reaching for it
    // costs a pattern load and no derivation from it can be applied here: the
    // selection step refuses a `$link` beside a `--filter` on the same grounds
    // this refusal names, and every derived bound is `$link`s.
    whyUnbounded = "This call's --filter is answered with the elements " +
      "themselves, which no longer say which positions they came from, so " +
      "the addresses a bound is written in cannot be composed beside it.";
  } else {
    const declared = await resolved.declaredResult?.();
    const bounded = await boundReadValue(receiptCell, declared, value);
    // The bound is only as good as the declaration: a position the declaration
    // left wide can still expand into the circle, and answering with a value
    // that cannot be written would move the same failure one step later.
    if (bounded !== undefined && circularResultPath(bounded) === undefined) {
      return bounded;
    }
    if (declared === undefined) {
      whyUnbounded = "This verb declares no result for `cf` to bound the " +
        "readback with.";
    } else {
      whyUnbounded = "This verb's declared result leaves the closing " +
        "position unbounded.";
    }
  }
  throw new CyclicResultError(
    `Cannot render the result of "${resolved.cellKey}": it closes a circle at ` +
      `"${cycle}", and JSON has no way to write one. The handling ` +
      "COMMITTED — the write landed, and only this rendering failed. " +
      whyUnbounded +
      " Collect the outcome with a shape that bounds it: " +
      (receiptId === undefined
        ? "read the receipt with --select or --schema."
        : `cf piece get --piece ${receiptId} ` +
          `--schema '{"properties":{"<field>":{"$link":true}}}'.`) +
      " Calling the verb again under --select or --schema shapes it at the " +
      "call, but runs the handler body a second time.",
  );
}

export async function executeResolvedCallable(
  resolved: CallableResolution,
  input: unknown,
  deps: CallableExecutionDeps = {},
): Promise<ExecutedCallable> {
  if (resolved.callableKind === "handler") {
    // Before anything is dispatched, and so before the invocation id can be
    // spent on a handling that would run with no event. An absent payload
    // is normalized to `{}` against an object schema (D5), so what goes out
    // is what the gate judged. A resolution carrying a richer published
    // schema than its dispatch cell (the forced-stream fallback) is judged
    // against that one.
    const dispatchInput = assertVerbInputSatisfiesSchema(
      resolved.cellKey,
      input,
      resolved.inputSchema ?? resolved.callableCell.schema,
    );
    const runtimeErrors = runtimeErrorLog(resolved.pieces.runtime);
    const errorCountBefore = runtimeErrors.length;
    const invocation = deps.invocation;
    const invocationId = invocation?.id;
    if (deps.skipReadback && invocation === undefined) {
      // Refused before dispatch: skipping the readback is only sound when a
      // later call can fetch the outcome, and that needs the pair naming it.
      throw new Error("--no-wait requires an invocation id");
    }
    deps.onPhase?.("dispatched");
    const tx = await new Promise<IExtendedStorageTransaction>(
      (resolve, reject) => {
        try {
          if (invocation !== undefined) {
            resolved.callableCell.send(dispatchInput, resolve, {
              // The id and the session that chose it travel together: an id
              // is the caller's own word, and only the pair decides which
              // receipt this handling files under.
              eventId: invocation.id,
              session: invocation.session,
            });
          } else {
            resolved.callableCell.send(dispatchInput, resolve);
          }
        } catch (error) {
          reject(error);
        }
      },
    );
    // Acknowledgment is transaction-local (verb contract, Settlement): the
    // commit callback above fires on THIS handling's final commit. Awaiting
    // runtime.idle()/pieces.synced() here instead would hold an
    // already-committed write hostage to every derived recomputation it
    // triggered elsewhere in the graph.
    deps.onPhase?.("committed");

    const txStatus = tx.status();
    const deduplicated = txStatus.status === "error" &&
      "precondition" in txStatus.error &&
      txStatus.error.precondition === "receipt-exists";
    if (txStatus.status === "error" && !deduplicated) {
      const latestRuntimeError = runtimeErrors.slice(errorCountBefore).at(-1)
        ?.message;
      throw new Error(
        `Handler "${resolved.cellKey}" failed: ${
          latestRuntimeError ?? errorMessage(txStatus.error)
        }`,
      );
    }

    if (invocationId === undefined) return {};

    // The handling's receipt address, taken off the transaction the commit
    // callback handed back (verb contract WS-D). It is known HERE — at
    // commit, before anything is read — which is what lets the detached exit
    // below publish an address for an outcome nobody waited for.
    const link = tx.handlingReceiptLink;
    const receiptAddress = link === undefined
      ? undefined
      : toInvocationResultLink(link);

    if (deps.skipReadback) {
      // --no-wait's exit point: the commit is acknowledged, so the
      // handling — and on a collision, the original one — is durable on
      // the server and survives this process. Only the readback
      // (sync + read of the outcome) is skipped; the address of the outcome
      // rides out regardless, so collecting it later is an ordinary read
      // rather than a same-id replay that re-runs the handler body.
      return {
        invocation: {
          id: invocationId,
          status: "committed",
          ...(deduplicated ? { deduplicated: true } : {}),
          ...(receiptAddress !== undefined ? { receipt: receiptAddress } : {}),
        },
      };
    }

    // Read the handling's outcome back off its receipt. On a receipt-exists
    // collision this is the ORIGINAL handling's receipt — same id, same
    // outcome — so a retry settles as a success. The receipt is a COMMIT
    // witness, not an execution witness: the redelivered event still ran the
    // handler body and then lost the race, so nothing committed twice while
    // effects outside the transaction repeated.
    deps.onPhase?.("readback");
    let result: unknown;
    let links: Record<string, InvocationResultLink> | undefined;
    if (link) {
      const receipt = resolved.pieces.runtime.getCellFromLink<any>(link);
      const value = await receipt.pull();
      // A value-less verb's receipt is an empty record — existence-only. The
      // witness is a PLAIN empty record specifically: a keyless instance (a
      // fabric primitive whose slots are private, `FabricBytes`) is a verb's
      // result, and counting enumerable keys alone would swallow it.
      if (
        value !== undefined &&
        !(isRecord(value) && !isInstance(value) &&
          Object.keys(value).length === 0)
      ) {
        result = value;
      }
      if (result !== undefined) {
        // Both steps run only where a result exists. Shaping the empty witness
        // would report `{}` for a verb whose whole answer is that it returned
        // nothing, and that omission is the distinction the empty receipt
        // exists to draw.
        if (deps.selection !== undefined) {
          result = await selectCallResult(
            resolved,
            receipt,
            deps.selection,
            deps,
          );
        }
        // Whatever the value in hand came from — the whole receipt, or the
        // caller's own shape over it — what goes out is written as JSON, and a
        // circle has no JSON writing at all. A selection is no exemption: a
        // projection that names the re-entering subtree whole keeps the circle
        // it selected. The check reads a value already in hand and touches no
        // storage, so a result that renders reaches stdout exactly as it always
        // has, and the bound below engages only where one does not.
        const cycle = circularResultPath(result);
        if (cycle !== undefined) {
          result = await boundCyclicResult(
            resolved,
            receipt,
            result,
            cycle,
            receiptAddress?.id,
            deps,
          );
        }
      }
      if (deps.showLinks) {
        // After readback and after the selection, off the same receipt the
        // result came from: the links annotate exactly the value the caller
        // is holding. A projection keeps every surviving path where it was,
        // so each address still names the position it annotates; a `--filter`
        // does not, which is why the command refuses that pair rather than
        // handing back addresses for elements the predicate moved.
        links = collectInvocationResultLinks(link, receipt, result);
      }
    }

    return {
      invocation: {
        id: invocationId,
        status: "settled",
        ...(deduplicated ? { deduplicated: true } : {}),
        ...(receiptAddress !== undefined ? { receipt: receiptAddress } : {}),
        ...(result !== undefined ? { result } : {}),
        ...(links !== undefined ? { links } : {}),
      },
    };
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
    resolved.callableCell.key("pattern").getRaw() ??
      resolved.callableCell.key("pattern").get(),
  );
  const extraParams = asExtraParams(
    resolved.callableCell.key("extraParams").get(),
  );
  const runtime = resolved.pieces.runtime;
  const runtimeErrors = runtimeErrorLog(runtime);
  const errorCountBefore = runtimeErrors.length;
  const tx = runtime.edit();
  const resultScope = resolved.callableCell.getAsNormalizedFullLink().scope;
  const resultCell = runtime.getCell<unknown>(
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
  const cancelSink = running.sink((value) => {
    if (value !== undefined) {
      sinkValue = value;
      hasSinkValue = true;
    }
  });

  let outputValue: unknown;
  try {
    await runtime.idle();
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    // Drain the tool to a fully settled state — scheduler idle, storage synced,
    // and every in-flight async builtin finished — so the result is final by the
    // time we read it. A synchronous tool has already written its result; an
    // async tool's LLM/fetch call is awaited to completion here, with no poll
    // interval under it and no deadline over it. `settled()` normalizes a failed
    // builtin to "settled", so a broken tool converges here rather than hanging.
    await runtime.settled();

    if (hasSinkValue) {
      outputValue = sinkValue;
    } else {
      // Fully settled with nothing on the sink: read once (a server-pushed value
      // can land without re-triggering the local effect).
      outputValue = await resultCell.pull();
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
    cancelSink();
  }

  if (deps.selection !== undefined) {
    // A tool's result reaches stdout through the same selection a handler's
    // does. It is read off the cell the tool wrote, which is where the value
    // above came from, so the shaped answer describes the same result.
    outputValue = await selectCallResult(
      resolved,
      resultCell,
      deps.selection,
      deps,
    );
  }

  // The result cell's durable address rides along: today the cell is
  // otherwise unlinked — reachable by nobody once this process exits (a named
  // defect in the verb-contract design). Handing the address back is the
  // smallest honest handle.
  const resultLink = resultCell.getAsNormalizedFullLink();
  return {
    outputText: JSON.stringify(outputValue, null, 2),
    resultRef: {
      space: resultLink.space,
      id: resultLink.id,
      scope: resultLink.scope,
    },
  };
}
