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
   * fetching the outcome back, because a caller-supplied id keeps that
   * fetch available forever: a later same-id call deduplicates against the
   * create-only receipt and returns the original outcome (verb contract
   * D1/D3). Requires an `invocation` — without one there is no receipt to
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

export async function executeResolvedCallable(
  resolved: CallableResolution,
  input: unknown,
  deps: CallableExecutionDeps = {},
): Promise<ExecutedCallable> {
  if (resolved.callableKind === "handler") {
    // Before anything is dispatched, and so before the invocation id can be
    // spent on a handling that would run with no event. An absent payload
    // is normalized to `{}` against an object schema (D5), so what goes out
    // is what the gate judged.
    const dispatchInput = assertVerbInputSatisfiesSchema(
      resolved.cellKey,
      input,
      resolved.callableCell.schema,
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
    const link = tx.handlingReceiptLink;
    if (link) {
      const receipt = resolved.pieces.runtime.getCellFromLink<any>(link);
      const value = await receipt.pull();
      // A value-less verb's receipt is an empty record — existence-only.
      if (
        value !== undefined &&
        !(isRecord(value) && Object.keys(value).length === 0)
      ) {
        result = value;
      }
      if (deps.selection !== undefined && result !== undefined) {
        // Only where a result exists. Shaping the empty witness would report
        // `{}` for a verb whose whole answer is that it returned nothing, and
        // that omission is the distinction the empty receipt exists to draw.
        result = await selectCallResult(
          resolved,
          receipt,
          deps.selection,
          deps,
        );
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
