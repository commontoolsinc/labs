import {
  type EntityRef,
  getModernCellRepConfig,
} from "@commonfabric/data-model/cell-rep";
import { jsonFromValue, valueFromJson } from "@commonfabric/data-model/codecs";
import { internPathSelector } from "@commonfabric/data-model/schema-utils";
import type {
  FabricPlainObject,
  FabricValue,
  SchemaPathSelector,
} from "@commonfabric/api";
import { EmptyReconstructionContext } from "@commonfabric/data-model/codec-common";
import { isObject, isRecord } from "@commonfabric/utils/types";
import { hashStringOf } from "@commonfabric/data-model/value-hash";

export const MEMORY_PROTOCOL = "memory" as const;
export const DEFAULT_BRANCH = "" as const;

export type EntityId = string;
export type BranchName = string;
export type SessionId = string;
export type SessionToken = string;
export type CellScope = "space" | "user" | "session";

/**
 * Protocol-level failure: a request whose SHAPE or identity preconditions
 * are invalid at this protocol layer (as opposed to a storage conflict or
 * an authorization denial). Defined here in the wire-shape module because
 * the shared scope-key vocabulary below throws it; `engine.ts` re-exports
 * it, so `Engine.ProtocolError` remains the same class object.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/**
 * The `scope_key` vocabulary — PROTOCOL vocabulary, defined ONCE here
 * beside {@link CellScope} (ledger LD3, owner 2026-08-03;
 * docs/specs/server-side-execution/key-vocabulary.md §3).
 *
 * A scope key names one INSTANCE of a scoped document: `space` (the one
 * shared instance), `user:<principal>` (one per user), or
 * `session:<principal>:<sessionId>` (one per session). Storage rows are
 * keyed by it, derived-commit write annotations carry it
 * ({@link DerivedWriteAnnotation}), lease-holder reads may name it
 * (protocol.md §2's read row), and the runner's in-memory identity keys
 * are built from it (the key-vocabulary.md §1 nine-site closure).
 * Segments are encodeURIComponent-encoded, so `:` splits segments
 * exactly and a key never contains `/`.
 *
 * Two rules keep this the ONE definition (key-vocabulary.md §4):
 * neither the engine's row keys nor the runner's in-memory keys may
 * restate the format, and a key is only ever CONSTRUCTED from an
 * explicitly supplied identity — the memory server derives that identity
 * from the authenticated session at admission for `authored` traffic; a
 * runner-side run receives it with the work (the demand for derivations,
 * the server-stamped `firedAt` for handlers; in the OFF arm it is the
 * runtime's own authenticated session) — never resolved from ambient
 * state.
 */
export type ScopeKey =
  | "space"
  | `user:${string}`
  | `session:${string}:${string}`;

/**
 * The identity a {@link resolveScopeKey} construction resolves against.
 * Supplied explicitly by the caller — see the construction rule on
 * {@link ScopeKey}.
 */
export type ScopeKeyIdentity = {
  principal?: string;
  sessionId?: SessionId;
};

const encodeScopeKeyPart = (value: string): string => encodeURIComponent(value);

/**
 * Constructor for the `session:<principal>:<sessionId>` key form, shared
 * between scope keys and the engine's commit session keys (which store the
 * same form for principal-carrying sessions).
 */
export const resolvePrincipalSessionKey = (
  principal: string,
  sessionId: SessionId,
): ScopeKey =>
  `session:${encodeScopeKeyPart(principal)}:${encodeScopeKeyPart(sessionId)}`;

/**
 * Principal segment of a `session:<principal>:<sessionId>` key (scope key
 * or stored commit session key — same form). Principal-less commit
 * session keys store the bare session id — no principal — and yield
 * `undefined` here. The segments are encodeURIComponent-encoded, so
 * splitting on ":" is exact.
 */
export const principalOfSessionKey = (key: string): string | undefined => {
  if (!key.startsWith("session:")) return undefined;
  const parts = key.split(":");
  if (parts.length !== 3) return undefined;
  try {
    return decodeURIComponent(parts[1]);
  } catch {
    return undefined;
  }
};

/**
 * THE shared `(scope, identity) → scope_key` constructor (LD3,
 * key-vocabulary.md §3). Pure: it is the caller that supplies the
 * identity — see the construction rule on {@link ScopeKey}. Throws
 * {@link ProtocolError} when the requested scope needs an identity
 * component the caller did not supply; it never invents or defaults one.
 */
export const resolveScopeKey = (
  scope: CellScope | undefined,
  identity: ScopeKeyIdentity,
): ScopeKey => {
  switch (scope ?? "space") {
    case "space":
      return "space";
    case "user":
      if (!identity.principal) {
        throw new ProtocolError(
          "user scoped memory operations require a principal",
        );
      }
      return `user:${encodeScopeKeyPart(identity.principal)}`;
    case "session":
      if (!identity.principal) {
        throw new ProtocolError(
          "session scoped memory operations require a principal",
        );
      }
      if (!identity.sessionId) {
        throw new ProtocolError(
          "session scoped memory operations require a session id",
        );
      }
      return resolvePrincipalSessionKey(identity.principal, identity.sessionId);
  }
};

/**
 * Inspect half of the vocabulary: the {@link CellScope} a scope key is an
 * instance of. Total — any string without a `user:`/`session:` prefix
 * reads as the space scope; use {@link isScopeKey} first where a value
 * needs validating rather than classifying.
 */
export const scopeOfScopeKey = (scopeKey: string): CellScope => {
  if (scopeKey.startsWith("session:")) {
    return "session";
  }
  if (scopeKey.startsWith("user:")) {
    return "user";
  }
  return "space";
};

/**
 * Whether a scope key is in the APPLICABLE SET of the given identity
 * (protocol.md §3): `space`, `user:<me>`, `session:<me>:<sid>`. Push is
 * filtered per recipient by this predicate — a subscriber receives only
 * rows whose scope_key is applicable to it; the remaining rows are
 * absent, not redacted. The lease-holder exemption (the SpaceServer
 * legitimately reads and receives every instance — protocol.md §2's read
 * row) is decided by the CALLER, not here.
 */
export const scopeKeyApplicableTo = (
  scopeKey: string,
  identity: ScopeKeyIdentity,
): boolean => {
  const scope = scopeOfScopeKey(scopeKey);
  if (scope === "space") return true;
  if (!canResolveScopeKey(scope, identity)) return false;
  return resolveScopeKey(scope, identity) === scopeKey;
};

/** Whether a string is a well-formed {@link ScopeKey}. */
export const isScopeKey = (value: string): value is ScopeKey => {
  if (value === "space") return true;
  if (value.startsWith("user:")) return value.length > "user:".length;
  if (value.startsWith("session:")) {
    const parts = value.split(":");
    return parts.length === 3 && parts[1].length > 0 && parts[2].length > 0;
  }
  return false;
};

/**
 * Whether {@link resolveScopeKey} can construct a key for `scope` from
 * `identity` — i.e. every identity component that scope requires is
 * supplied. The predicate twin of the constructor's throw conditions, for
 * paths that must SKIP unresolvable scopes (e.g. a session with no
 * principal reacting to another principal's user-scoped dirtiness) rather
 * than fail.
 */
export const canResolveScopeKey = (
  scope: CellScope | undefined,
  identity: ScopeKeyIdentity,
): boolean => {
  switch (scope ?? "space") {
    case "space":
      return true;
    case "user":
      return !!identity.principal;
    case "session":
      return !!identity.principal && !!identity.sessionId;
  }
};

/**
 * Protocol-level rejection of a DUPLICATE event append (events.md §4's
 * dedupe horizon): the commit declared an `eventId` that already exists
 * among the stream's entries above its `eventWatermark` (or in a not-yet-
 * consequenced seq-less entry — the stage-G interim arm, which retires as
 * processing marks entries consequenced). Distinguished by NAME from the
 * generic {@link ProtocolError} so a client discharging its offline queue
 * (events.md §5, LT9) can treat "already appended" as delivered rather
 * than as a failure to surface: the first append landed, its consequences
 * are (or will be) the authoritative outcome, and re-raising would
 * re-discharge forever.
 */
export class EventAppendDuplicateError extends ProtocolError {
  constructor(message: string) {
    super(message);
    this.name = "EventAppendDuplicateError";
  }
}

/**
 * The commit classes of server-execution v2
 * (docs/specs/server-side-execution/protocol.md §1). A closed set of three:
 * `authored` (any authorized session's own writes and event appends),
 * `derived` (the space's lease-holding SpaceServer committing derivation
 * results), `system` (the memory server itself: bootstrap-style direct
 * writes). The class is SERVER-DETERMINED at admission — assigned by which
 * admission path processed the commit, never a client-supplied field — and
 * every commit carries one in both flag arms; only the ON arm enforces the
 * per-class admission rows (protocol.md §2). Protocol vocabulary, so it is
 * defined once here in the wire-shape module (protocol.md §7).
 */
export type CommitClass = "authored" | "derived" | "system";
export const COMMIT_CLASSES: readonly CommitClass[] = [
  "authored",
  "derived",
  "system",
];

/**
 * The well-known watermark doc, one per space (protocol.md §4): "derived
 * state is current through commit seq N." A SPACE-scoped instance
 * (`scope_key = "space"`), updated inside the same transaction as derived
 * commits — never its own commit. Protocol vocabulary: clients read it for
 * settledness (`waitForSettled`, testing.md §3) and sync indicators, the
 * serving loop writes it, so the id is defined once here. The document
 * value is {@link WatermarkDocValue}.
 */
export const SERVER_EXECUTION_WATERMARK_DOC_ID =
  "of:server-execution-watermark";

/** The watermark doc's value shape (protocol.md §4): W is ONE integer per
 * space — not per doc, not per piece, never vectorized. */
export type WatermarkDocValue = { seq: number };

// ---------------------------------------------------------------------------
// Events-down (server-execution v2 Phase 3, D-v2-1;
// docs/specs/server-side-execution/events.md). The event is an AUTHORED
// APPEND to a stream document — the client's only computational commit
// under the flag. Protocol vocabulary, defined once here (protocol.md §7:
// `eventId`/`firedAt` are commit-metadata additions for event appends).
// ---------------------------------------------------------------------------

/**
 * The stream-entries SIDECAR doc id for one stream (events.md §1's "stream
 * document", concretely). A pattern's stream VALUE lives at a path inside
 * a piece's result doc, and that doc is derivation-owned — a result
 * recompute writes it wholesale, so durable event entries could never
 * live there. Each stream therefore gets ONE dedicated entries doc,
 * derived DETERMINISTICALLY from the stream's link (id + path + scope) so
 * every party — the firing client, the SpaceServer's drain, a foreign
 * space's outbox delivery — addresses the same doc with no coordination.
 * The sidecar IS the spec's stream document: `eventWatermark` is a field
 * on it (events.md §4), the dropped-event notice annotates its entries
 * (events.md §5 T7), and compaction trims it (§4's allowance).
 *
 * The id is content-derived (`hashStringOf` — type-tagged,
 * length-prefixed, deterministic across processes), so distinct streams
 * never collide and no component can impersonate another.
 */
export const STREAM_ENTRIES_DOC_PREFIX = "of:stream-events:";

/** The stream link a sidecar doc (and each of its entries) names: enough
 * to reconstruct the scheduler event link — `areNormalizedLinksSame`
 * compares id + space + scope + path, and space is implicit (the sidecar
 * lives in the stream's own space). */
export type StreamLinkRef = {
  id: EntityId;
  path: readonly string[];
  scope?: CellScope;
};

export const streamEntriesDocId = (stream: StreamLinkRef): EntityId =>
  `${STREAM_ENTRIES_DOC_PREFIX}${
    hashStringOf({
      id: stream.id,
      path: [...stream.path],
      scope: stream.scope ?? "space",
    })
  }`;

/**
 * `firedAt` — SERVER-STAMPED at admission (events.md §1, protocol.md §2):
 * `user` and `session` come from the authenticated commit envelope (or,
 * for delegated appends, the validated carried actor; for wave-carried
 * same-space entries, the inherited actor the one-trust-environment
 * derived commit wrote — LT1). `session` is the literal `"server"` for a
 * chain with no acting session. `clientSeq` is the ONLY client-minted
 * part: it orders one client session's own appends and steers nothing;
 * server-originated entries never carry it (LT7).
 */
export type StreamEventFiredAt = {
  user?: string;
  session: SessionId | "server";
  clientSeq?: number;
};

/**
 * One durable event entry on a stream's sidecar doc (`value.entries[i]`).
 * `payload` is the only client-authored content field (events.md §1);
 * `seq` is ENGINE-STAMPED at apply time with the appending commit's seq —
 * the stream seq the idempotency rule keys on (events.md §4) — and
 * `firedAt` is server-stamped per the class of the admitting commit.
 * `consequenced`/`error`/`status`/`reason` are PROCESSING-side fields
 * written only by the space's SpaceServer as the event's consequence
 * (events.md §5: an error/drop IS the consequence); admission REFUSES an
 * incoming append that pre-supplies any of them.
 */
export type StreamEventEntry = {
  eventId: string;
  /** The stream this entry targets — self-describing so the drain, the
   * dropped-notice reader, and compaction never need a reverse map. */
  stream: StreamLinkRef;
  payload?: FabricValue;
  firedAt?: StreamEventFiredAt;
  /** Engine-stamped: the appending commit's seq. */
  seq?: number;
  /** Runtime-injection provenance for the payload's injected keys,
   * carried so the server-side handler run's closed-world gate judges
   * the payload as the firing client's runtime did (same in-process
   * trust as today's client-side enforcement). */
  runtimeInjectedEventKeys?: string[];
  /** Processing-side (SpaceServer-written): consequences committed. */
  consequenced?: boolean;
  /** Processing-side: the handler threw — the error IS the consequence
   * (events.md §5). */
  error?: string;
  /** Processing-side: the dropped-event notice (events.md §5 T7) —
   * `{ status: "dropped", reason }` on the entry itself. */
  status?: "dropped";
  reason?: string;
  /** Processing-side (OW14, protocol.md §2b's LT4 ruling): failure
   * notices for CROSS-SPACE appends this event's handler emitted whose
   * DELIVERY was refused deterministically at the target — written by
   * the source SpaceServer's outbox BEFORE the refused row retires,
   * deduped by the refused append's eventId. The source event's own
   * consequences stand (they committed long before); this annotates
   * the entry per events.md §5's error-is-the-consequence shape. */
  deliveryFailures?: Array<{
    eventId: string;
    targetSpace: string;
    reason: string;
  }>;
};

/** The sidecar doc's value shape: the entry log plus the per-stream
 * processing watermark (events.md §4 — written only in the same derived
 * commit as the consequences it covers, never its own commit). */
export type StreamEventsDocValue = {
  entries?: StreamEventEntry[];
  eventWatermark?: number;
};

/**
 * One declared event append on a commit (protocol.md §2's authored
 * event-append row; §7's `eventId` envelope classification): names the
 * sidecar doc and the eventId so admission can locate the appended entry
 * in the commit's operations, run the dedupe-horizon CAS, and stamp
 * `firedAt` + `seq`. Carried on `ClientCommit` for client fires, on wave
 * batches for LT1 same-space carriage, and constructed server-side for
 * delegated deliveries — one stamping site, three identity sources
 * (protocol.md §2's three rows).
 */
export type EventAppendDecl = {
  /** The stream's sidecar doc ({@link streamEntriesDocId}). */
  id: EntityId;
  scope?: CellScope;
  eventId: string;
};

// ---------------------------------------------------------------------------
// The client-effect channel (server-execution v2 Phase 4;
// docs/specs/server-side-execution/protocol.md §5). Session-scoped,
// server-computed, client-enacted effects: the SpaceServer writes INTENT
// entries into the acting session's instance of the ONE well-known effects
// doc, the session's client enacts and ACKS by nonce (an ordinary authored
// write into its own instance), and the next wave retires acked entries.
// Protocol vocabulary, defined once here (the LD3 direction).
// ---------------------------------------------------------------------------

/**
 * The well-known client-effects doc, one id per space (protocol.md §5,
 * T9): the effects doc is a SESSION-SCOPED INSTANCE of this one doc id —
 * `scope_key = session:<principal>:<sessionId>` — never a path
 * convention. The SpaceServer writes intents into the acting session's
 * instance by naming that key (seal-time addressing annotations); the
 * session's own client resolves the same instance from its authenticated
 * session and never names a key. The document value is
 * {@link SessionEffectsDocValue}. Session-lifetime: a retired session's
 * unacked intents retire with its effects instance under the SAME
 * session-data GC as every other session instance (scopes.md §3).
 */
export const SERVER_EXECUTION_EFFECTS_DOC_ID = "of:server-execution-effects";

/** The navigation target an intent carries (builtins.md §4): an entity
 * link. `space` is absent for a target within the computing space (the
 * common case). A cross-space TARGET is legal — LT3 defers the
 * cross-space CONTEXT (the acting session must be connected to the
 * COMPUTING space), not the destination: "the CONTEXT is same-space
 * even when the navigation TARGET is a cross-space link". */
export type EffectIntentTarget = {
  space?: string;
  id: EntityId;
  path: readonly string[];
  scope?: CellScope;
};

/**
 * One client-effect intent entry (protocol.md §5's shape): `{ nonce,
 * kind, args, issuedIn }`. v2 ships exactly ONE kind — `navigate` — and
 * a new kind is a protocol.md §5 spec edit first.
 *
 * `nonce` is minted server-side as a DETERMINISTIC function of the
 * firing event and the navigateTo instance ({@link effectIntentNonce}),
 * which is what lets the client's OPTIMISTIC enactment (speculation.md
 * §2's local enact) predict the same nonce and converge on the
 * authoritative intent without re-enacting — exactly-once per nonce is
 * the CLIENT's duty (T2.Q2/Q7).
 *
 * `issuedIn` is the derived commit seq that issued the intent —
 * ENGINE-STAMPED at apply time (the stream-entry `seq` precedent): the
 * producer writes the `null` sentinel (the wave's own seq is allocated
 * only at the commit step), and the engine stamps derived-class writes
 * of this doc. Informational: nothing in the ack/retirement lifecycle
 * reads it.
 */
export type EffectIntentEntry = {
  nonce: string;
  kind: "navigate";
  args: { target: EffectIntentTarget };
  issuedIn: number | null;
};

/**
 * The effects doc's value shape (protocol.md §5): the intent append-list
 * plus the session's ack marks. The ACK is an ordinary AUTHORED write by
 * the owning session into its own instance — `acks[nonce] = true`, one
 * mark per nonce so concurrent acks of distinct intents never overwrite
 * each other (ack-by-nonce is once-per-nonce; a scalar last-ack field
 * would lose an earlier unretired ack under two quick intents). The
 * SpaceServer's next-wave retirement removes acked entries AND their
 * marks in one bookkeeping-stamped write (serving-loop.md §3d).
 */
export type SessionEffectsDocValue = {
  entries?: EffectIntentEntry[];
  acks?: Record<string, true>;
};

/**
 * THE nonce constructor (protocol.md §5; T2.Q2's "nonce minted
 * server-side" with T2.Q7's convergence): deterministic over the firing
 * event's durable id and the navigateTo instance's cause-derived result
 * doc id. Both sides compute it — the SERVED half when it writes the
 * intent, the client's SPECULATIVE run when it optimistically enacts —
 * so the optimistic enactment carries the same nonce the authoritative
 * intent arrives with (result-as-pattern children converge by
 * cause-derived identity, speculation.md §2; the instance id is that
 * convergence). One event × one navigateTo instance ⇒ one nonce, so a
 * re-run of either side is idempotent by presence check.
 */
export const effectIntentNonce = (
  eventId: string,
  instanceId: string,
): string => `nav:${hashStringOf({ eventId, instance: instanceId })}`;

/**
 * Inspect half for instance keys (the retirement writer's parse): the
 * {@link ScopeKeyIdentity} embedded in a `user:`/`session:` scope key,
 * or undefined for `space` and malformed keys. The segments are
 * encodeURIComponent-encoded, so `:`-splitting is exact
 * (key-vocabulary.md §Anchors).
 */
export const identityOfScopeKey = (
  scopeKey: string,
): ScopeKeyIdentity | undefined => {
  if (scopeKey.startsWith("session:")) {
    const parts = scopeKey.split(":");
    if (parts.length !== 3) return undefined;
    try {
      return {
        principal: decodeURIComponent(parts[1]),
        sessionId: decodeURIComponent(parts[2]),
      };
    } catch {
      return undefined;
    }
  }
  if (scopeKey.startsWith("user:")) {
    const part = scopeKey.slice("user:".length);
    if (part.length === 0) return undefined;
    try {
      return { principal: decodeURIComponent(part) };
    } catch {
      return undefined;
    }
  }
  return undefined;
};
/**
 * The identity annotation on one write WITHIN a derived-class commit's body
 * (protocol.md §1's transaction identity model, §7's closed metadata list).
 * The wave's envelope carries the SpaceServer's service identity — no user
 * principal, no session — so the identity the envelope can no longer
 * express rides here, per write, at action-run granularity. Two distinct
 * things, never conflated:
 *
 * - ADDRESSING — `scopeKey`, the explicit instance a scoped write lands
 *   in. The engine keys rows by it; admission REQUIRES it on every scoped
 *   write of a derived commit (a service envelope has no session for
 *   `resolveScopeKey` to derive a key from, and silently resolving
 *   `user:<serviceDID>` is the empty-instance trap protocol.md §2 exists
 *   to prevent).
 * - ATTRIBUTION — `actingUser`/`actingSession`, the acting identity of the
 *   action RUN that produced the write (`action × instance`, never the
 *   action). Recorded, not read: no enforcement path consumes it today
 *   (protocol.md §1 — audit/forensics, and the anticipated signature
 *   graduation).
 *
 * Server-internal carriage like `commitClass` and `holder`: `ClientCommit`
 * cannot express annotations, and no session-facing path supplies them.
 * Defined once here in the wire-shape module beside `CommitClass` so the
 * engine and the runner's wave machinery share one shape (the LD3
 * direction; stage E moves the full scope_key format here too).
 */
export type DerivedWriteAnnotation = {
  /** Index into the commit's operations array. */
  op: number;
  scopeKey?: string;
  actingUser?: string;
  actingSession?: string;
};
export type Reference = string & {
  readonly __memoryV2Reference: unique symbol;
};
export type DocumentPath = readonly string[] & {
  readonly __memoryV2DocumentPath: unique symbol;
};
export type ValuePath = readonly string[] & {
  readonly __memoryV2ValuePath: unique symbol;
};
export type ReadPath = DocumentPath;
export type DocumentSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: DocumentPath };
export type ValueSchemaPathSelector =
  & Omit<SchemaPathSelector, "path">
  & { path: ValuePath };

/**
 * A logical stored document. Today the system only produces and consumes the
 * `value` field; `source` and any additional metadata fields are reserved for
 * future use and carried as opaque payload (a document is validated merely as
 * "an object" — see {@link isEntityDocument}).
 */
export type EntityDocument = {
  value?: FabricValue;
  source?: EntityRef;
  [key: string]: FabricValue;
};

export type Blob = {
  hash: Reference;
  value: Uint8Array;
  contentType: string;
  size: number;
};

export type PatchOp =
  | { op: "replace"; path: string; value: FabricValue }
  | { op: "add"; path: string; value: FabricValue }
  | { op: "remove"; path: string }
  | { op: "move"; from: string; path: string }
  | {
    op: "splice";
    path: string;
    index: number;
    remove: number;
    add: FabricValue[];
  }
  // A tail-relative append: `values` are inserted at the array's current tail,
  // with the array (and the path to it) created if absent. Carries no index, so
  // concurrent appends merge against durable state rather than clobbering via a
  // position computed from a stale base. `createsKey` — see below.
  | { op: "append"; path: string; values: FabricValue[]; createsKey?: true }
  // Set-add by identity: each of `values` is appended at the tail only if no
  // existing element of the array equals it (by stored-value equality), with the
  // array created if absent. Idempotent and commutative, so concurrent adds of
  // distinct elements merge and a repeated add is a no-op against durable state.
  | { op: "add-unique"; path: string; values: FabricValue[]; createsKey?: true }
  // Remove every element of the array at `path` that equals `value` by
  // stored-value equality. Idempotent (removing an absent value is a no-op) and
  // resolved against durable state, so it merges with concurrent writes instead
  // of clobbering via a whole-array rewrite. For a list of links this removes
  // the membership entry by its (deterministic) link, without reading the list.
  | { op: "remove-by-value"; path: string; value: FabricValue }
  // Numeric increment: `by` (which may be negative) is added to the number at
  // `path`, treating an absent value as 0 and creating the path if absent.
  // Applied against durable state, so concurrent increments sum rather than
  // clobber via last-write-wins. `createsKey` — see below.
  | { op: "increment"; path: string; by: number; createsKey?: true };

// `createsKey` (append / add-unique / increment): set by the writer when the op
// MATERIALIZES a previously-absent path — its own transaction base held no value
// at `path`, so applying it adds `path`'s last segment as a key to the parent
// container. It does not change how the op applies (these ops already
// create-if-absent); it tells the conflict matcher to invalidate a shape-only
// (nonRecursive) reader of the parent, whose key set changed. Absent/false means
// the target already existed, so only its value changed and no parent shape
// reader need conflict. The writer's base is authoritative for "never miss a
// genuine conflict": the first commit that creates a key necessarily saw it
// absent and sets the flag; a later append to the now-present key does not. A
// stale base can only set the flag when the key already existed durably, which
// over-conflicts a parent shape reader conservatively (an extra retry), never
// missing one. See docs/specs/memory-v2/08-conflict-granularity.md.

export type SetOperation = {
  op: "set";
  id: EntityId;
  scope?: CellScope;
  value: EntityDocument;
};

export type PatchOperation = {
  op: "patch";
  id: EntityId;
  scope?: CellScope;
  patches: PatchOp[];
};

export type DeleteOperation = {
  op: "delete";
  id: EntityId;
  scope?: CellScope;
};

/**
 * A SQLite write folded into the commit, applied inside the same transaction as
 * the cell ops (atomic). It is NOT an entity revision — it has no `id` and never
 * enters the revision/head/snapshot/dirty machinery (see SqliteDbRef below /
 * docs/specs/sqlite-builtin/plans/atomic-writes.md).
 */
export type SqliteOperation = {
  op: "sqlite";
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
};

export type Operation =
  | SetOperation
  | PatchOperation
  | DeleteOperation
  | SqliteOperation;

export type ConfirmedRead = {
  id: EntityId;
  scope?: CellScope;
  branch?: BranchName;
  path: ReadPath;
  seq: number;
  /**
   * When true, this is a SHALLOW (shape-only) read — the reader observed the
   * container at `path` (its key set / existence) but did NOT depend on the deep
   * values of its descendants. The engine then conflicts only with writes
   * AT-OR-ABOVE `path` (including key add/remove, whose patch injects the parent
   * path), not with disjoint deep-value writes strictly below `path`. Strict
   * subset of the recursive overlap ⇒ never a false-negative. Absent/false ⇒
   * recursive read (the historical behavior).
   */
  nonRecursive?: boolean;
};

export type PendingRead = {
  id: EntityId;
  scope?: CellScope;
  path: ReadPath;
  /**
   * The reader's pending-stack dependency set for this document. An array
   * lists EVERY pending layer the read's materialized view sat on; each
   * element must have resolved to an accepted commit for this commit to be
   * applicable, and the staleness (conflict) check runs exactly once, from
   * the basis the server selects (03-commit-model.md §3.6.3): the declared
   * `basisSeq` when present, else the resolution of the HIGHEST element —
   * the document's top-of-stack layer below the reader, which the array
   * MUST include. A scalar is the degenerate single-layer form (also what
   * pre-`pendingReadStacks` peers emit: top-of-stack only, carrying no
   * lower-layer dependencies).
   */
  localSeq: number | number[];
  /**
   * The reader's confirmed basis for THIS document, in the SERVER's
   * space-log seq space (an accepted-commit `seq`, NOT the session's
   * localSeq space): the seq of the last accepted write to this document
   * that the client's confirmed view reflected at build time, or 0 for a
   * document its subscriptions never covered.
   *
   * When present, the staleness scan covers the FULL interval
   * `(basisSeq, head]`, excluding only the session's own TRUE PREDECESSOR
   * commits — those with a localSeq below the reader's, the accepted layers
   * its materialized view included. An own write with a higher localSeq
   * accepted first (out-of-order submission) conflicts like a foreign
   * write, so soundness does not depend on wire-order discipline. This is
   * the CT-1910 repair
   * (`PendingStacks_Repaired.cfg` certifies it); when absent (a legacy
   * client), staleness is based at the HIGHEST dependency's resolution seq,
   * whose known unsoundness is recorded against INV-1 in
   * docs/specs/memory-v2/09-invariants.md.
   */
  basisSeq?: number;
  /** See {@link ConfirmedRead.nonRecursive}. */
  nonRecursive?: boolean;
};

export type CommitPrecondition =
  | {
    kind: "origin-committed";
    /** localSeq of a commit from the SAME session in this space. */
    originLocalSeq: number;
  }
  | {
    kind: "entity-absent";
    id: EntityId;
    scope?: CellScope;
  }
  | {
    /** Security-critical exact value pin, including null for absent/deleted. */
    kind: "entity-value-hash";
    id: EntityId;
    scope?: CellScope;
    valueHash: string | null;
  };

export type ClientCommit = {
  localSeq: number;
  reads: {
    confirmed: ConfirmedRead[];
    pending: PendingRead[];
  };
  operations: Operation[];
  preconditions?: CommitPrecondition[];
  codeCID?: Reference;
  branch?: BranchName;
  merge?: {
    sourceBranch: BranchName;
    sourceSeq: number;
    baseBranch: BranchName;
    baseSeq: number;
  };
  /** Server-execution v2 Phase 3 (events.md §1): the commit's declared
   * event appends. Only flag-ON clients produce this; admission under
   * the flag runs the dedupe-horizon CAS and stamps `firedAt` + `seq`
   * into the appended entries ({@link EventAppendDecl}). Refused when
   * the flag is off. */
  eventAppends?: EventAppendDecl[];
};

export type SessionOpenResult = {
  sessionId: SessionId;
  sessionToken: SessionToken;
  serverSeq: number;
  caughtUpLocalSeq?: number;
  resumed?: boolean;
  sync?: SessionSync;
  sessionOpen: SessionOpenAuthMetadata;
};

export type MemoryProtocolFlags = {
  modernCellRep: boolean;
  commitPreconditions: boolean;
  /** Hash-keyed per-frame schema table. */
  syncSchemaTableV2: boolean;
  /**
   * Server capability (CFC Phase 3.c): commit-folded `sqlite` writes to
   * rule-bearing tables are re-derived through the shared row-label evaluator
   * against the committed rows, rolling back on violation (see
   * `v2/sqlite/commit-eval.ts`). The RUNNER keys its write-gate relaxation for
   * the non-attributable shapes (INSERT…SELECT, upsert, columnless INSERT,
   * rule-input UPDATE) on the SERVER advertising this — an old server that
   * never evaluates keeps a new runner failing closed. Inherent to the build
   * (not configuration), so a server of this version always advertises it.
   */
  sqliteCommitRowLabelEval: boolean;
  /**
   * Server capability (CT-1872 1c): pending reads may carry an ARRAY
   * `localSeq` naming every pending layer the read sat on (resolution
   * required for each element; staleness based at the highest — see
   * `PendingRead.localSeq`). A client that sees this absent (an older
   * server) falls back to scalar top-of-stack emission, and MUST hold each
   * such send until every omitted lower dependency has settled — otherwise
   * the old server could durably accept a commit the client cascade-rejects
   * (03-commit-model.md §3.5). Inherent to the build, so a server of this
   * version always advertises it.
   */
  pendingReadStacks: boolean;
  /**
   * Server capability (CT-1927): the server stages a `caughtUpLocalSeq`
   * catch-up obligation for every accept and every conflict rejection —
   * other rejection kinds carry none — so the batched fan-out's next frame to the
   * committing session carries a marker covering the verdict (an
   * otherwise-empty frame if nothing it watches is dirty). The CLIENT keys
   * verdict parking on this: it holds an accepted commit's promotion
   * (pending overlay to confirmed mirror) until the marker covers it, so
   * promotion extrapolates over a base reflecting the foreign novelty the
   * accept was applied on top of. A client that sees this absent (an older
   * server that stamps markers only for conflicts) applies verdicts
   * immediately, as before. Inherent to the build, so a server of this
   * version always advertises it.
   */
  verdictCatchUpMarkers: boolean;
  /** The server can list live space-scoped entity identifiers without values. */
  entityIdListing: boolean;
  /** The server can page one stable entity-identifier snapshot. */
  entityIdPagination: boolean;
  /** The server can test one entity identifier without loading its value. */
  entityIdLookup: boolean;
};

/**
 * Wire-format flags object.
 */
export type WireMemoryProtocolFlags = {
  modernCellRep?: boolean;
  commitPreconditions?: boolean;
  syncSchemaTableV2?: boolean;
  sqliteCommitRowLabelEval?: boolean;
  pendingReadStacks?: boolean;
  verdictCatchUpMarkers?: boolean;
  entityIdListing?: boolean;
  entityIdPagination?: boolean;
  entityIdLookup?: boolean;
};

export type HelloMessage = {
  type: "hello";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
};

export type HelloOkMessage = {
  type: "hello.ok";
  protocol: typeof MEMORY_PROTOCOL;
  flags: WireMemoryProtocolFlags;
  sessionOpen?: SessionOpenAuthMetadata;
};

export type SessionOpenChallenge = {
  value: string;
  expiresAt: number;
};

export type SessionOpenAuthMetadata = {
  challenge: SessionOpenChallenge;
  audience: string;
};

export type SessionDescriptor = {
  sessionId?: SessionId;
  seenSeq?: number;
  sessionToken?: SessionToken;
};

export type SessionOpenRequest = {
  type: "session.open";
  requestId: string;
  space: string;
  session: SessionDescriptor;
  invocation?: Record<string, unknown>;
  authorization?: FabricValue;
};

export type GraphQueryRoot = {
  id: EntityId;
  scope?: CellScope;
  /**
   * The explicit scope INSTANCE this read names (protocol.md §2's read
   * row; the read half of §1's transaction identity model, ledger LD5).
   * The ONE read-side addition to the wire: admissible only for a live
   * lease holder on the co-hosted memory server — a non-holder naming one
   * is REJECTED — and a read naming none resolves from the authenticated
   * session as today (the shared `resolveScopeKey`). Exists because a
   * SpaceServer reading under its service envelope would otherwise
   * silently resolve `user:<serviceDID>` — an empty instance, not an
   * error (the silent-empty-instance trap).
   */
  entityScopeKey?: ScopeKey;
  selector: SchemaPathSelector;
};

export type GraphQuery = {
  roots: GraphQueryRoot[];
  atSeq?: number;
  branch?: BranchName;
  excludeSent?: boolean;
};

export type EntitySnapshot = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  seq: number;
  document: EntityDocument | null;
};

export type GraphQueryResult = {
  serverSeq: number;
  entities: EntitySnapshot[];
};

export type EntityIdListResult = {
  serverSeq: number;
  ids: EntityId[];
  nextAfter?: EntityId;
};

/** Maximum number of entity identifiers carried by one protocol response. */
export const MAX_ENTITY_ID_PAGE_SIZE = 1_000;

export type EntityIdListOptions = {
  after?: EntityId;
  limit?: number;
  expectedServerSeq?: number;
};

export type EntityIdLookupResult = {
  serverSeq: number;
  exists: boolean;
};

export type QueryWatchSpec = {
  id: string;
  kind: "query";
  query: GraphQuery;
};

export type GraphWatchSpec = {
  id: string;
  kind: "graph";
  query: GraphQuery;
};

export type WatchSpec = QueryWatchSpec | GraphWatchSpec;

export type SessionSyncUpsert = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
  seq: number;
  doc?: EntityDocument;
  deleted?: true;
};

export type SessionSyncRemove = {
  branch: BranchName;
  id: EntityId;
  scope?: CellScope;
};

export type SessionSync = {
  type: "sync";
  fromSeq: number;
  toSeq: number;
  caughtUpLocalSeq?: number;
  upserts: SessionSyncUpsert[];
  removes: SessionSyncRemove[];
};

export type WatchSetResult = {
  serverSeq: number;
  sync: SessionSync;
};

export type WatchAddResult = {
  serverSeq: number;
  sync: SessionSync;
};

export type SessionAckResult = {
  serverSeq: number;
};

export type TransactRequest = {
  type: "transact";
  requestId: string;
  space: string;
  sessionId: SessionId;
  commit: ClientCommit;
};

export type GraphQueryRequest = {
  type: "graph.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  query: GraphQuery;
};

export type EntityIdListRequest = {
  type: "entity-id.list";
  requestId: string;
  space: string;
  sessionId: SessionId;
  after?: EntityId;
  limit?: number;
  expectedServerSeq?: number;
};

export type EntityIdLookupRequest = {
  type: "entity-id.exists";
  requestId: string;
  space: string;
  sessionId: SessionId;
  id: EntityId;
};

// --- SQLite builtins (docs/specs/sqlite-builtin) ---

/** Wire form of SQLite bind parameters. */
export type SqliteParamsWire =
  | ReadonlyArray<FabricValue>
  | Record<string, FabricValue>;

/** Reference to a cell-derived SQLite database: an opaque id (the handle cell's
 *  entity id) plus the declared table schemas (for additive create/migrate).
 *
 *  `scope` is the SqliteDb cell's declared scope (space/user/session). The
 *  server folds it (with the request's principal / session id) into the on-disk
 *  filename so a `user`/`session`-scoped db gets a per-user / per-session file;
 *  `space` (or absent) keeps the original unqualified name. */
export type SqliteDbRef = {
  id: string;
  tables?: Record<string, FabricValue>;
  scope?: CellScope;
  /** The db's owner — the principal that created the SqliteDb cell. Resolves
   *  the per-row label rule's `dbOwner()` term (CFC Phase 3); a FIXED db
   *  property, captured once at handle creation, never the acting reader. */
  owner?: string;
};

export type SqliteQueryRequest = {
  type: "sqlite.query";
  requestId: string;
  space: string;
  sessionId: SessionId;
  db: SqliteDbRef;
  sql: string;
  params?: SqliteParamsWire;
};

/** A result column's output name plus its TRUE source `(table, column)` origin
 *  (null for an expression/computed/compound column). */
export type SqliteResultColumn = {
  output: string;
  table: string | null;
  column: string | null;
};

/** Whether a column's `ifc` annotation is present and non-empty — the single
 *  predicate for "this column participates in CFC labeling". Shared by the
 *  server's declares-ifc gate (which decides whether to capture column origins)
 *  and the runner's per-column label schema, so the two can't drift. */
export function columnDeclaresIfc(ifc: unknown): boolean {
  return !!ifc && typeof ifc === "object" && Object.keys(ifc).length > 0;
}

/** Whether a table schema carries a per-row label rule (CFC Phase 3). */
export function tableDeclaresRowLabel(table: unknown): boolean {
  if (!table || typeof table !== "object") return false;
  const spec = (table as { rowLabel?: unknown }).rowLabel;
  return !!spec && typeof spec === "object";
}

/** Whether a read of this db needs sound per-result-column provenance for CFC
 *  labeling: any column declares `ifc` (Phase 2) OR any table declares a
 *  per-row label rule (Phase 3 — the rule's input columns are located by TRUE
 *  origin, never output name). The single gate shared by the server (capture
 *  origins) and the runner (expect them), so the two can't drift. Unlabeled
 *  dbs — the common case — return false and pay nothing. */
export function dbNeedsColumnProvenance(
  tables: Record<string, unknown> | undefined,
): boolean {
  if (tables === undefined) return false;
  for (const table of Object.values(tables)) {
    if (tableDeclaresRowLabel(table)) return true;
    const props = (table as { properties?: Record<string, unknown> })
      ?.properties;
    if (!props) continue;
    for (const col of Object.values(props)) {
      if (columnDeclaresIfc((col as { ifc?: unknown })?.ifc)) return true;
    }
  }
  return false;
}

export type SqliteQueryResult = {
  rows: FabricPlainObject[];
  /** Per-result-column origin, present ONLY when the db needs provenance for
   *  CFC labeling — any column declares `ifc` (Phase 2) or any table declares
   *  a per-row label rule (Phase 3); see `dbNeedsColumnProvenance`. An aliased
   *  or joined column maps back to its declared `(table, column)`. Undefined
   *  otherwise, so unlabeled queries pay nothing. */
  columns?: SqliteResultColumn[];
};

// NOTE: there is no `sqlite.execute` write verb. Writes go through the commit
// fold (a `sqlite` op inside `transact`, applied atomically with cell ops by the
// engine) — never a standalone, non-atomic write RPC. See db.exec in the runner.

/**
 * Register an injected on-disk SQLite source (Phase 7, read-only v1). `cf piece
 * link <piece> <field> sqlite:<absPath>` issues this so the server attaches the
 * given file (read-only) for the handle id instead of the cell-derived path. The
 * descriptor is server-side state — it is NOT written into the handle cell value.
 */
export type SqliteRegisterDiskSourceRequest = {
  type: "sqlite.register-disk-source";
  requestId: string;
  space: string;
  sessionId: SessionId;
  /** Handle cell id (content-derived from (serviceSpace, absPath); see cf). */
  id: string;
  /** Absolute path to the on-disk SQLite file. */
  path: string;
};

export type SqliteRegisterDiskSourceResult = {
  registered: true;
};

export type WatchSetRequest = {
  type: "session.watch.set";
  requestId: string;
  space: string;
  sessionId: SessionId;
  watches: WatchSpec[];
};

export type WatchAddRequest = {
  type: "session.watch.add";
  requestId: string;
  space: string;
  sessionId: SessionId;
  watches: WatchSpec[];
};

export type SessionAckRequest = {
  type: "session.ack";
  requestId: string;
  space: string;
  sessionId: SessionId;
  seenSeq: number;
};

export type ResponseMessage<Result> = {
  type: "response";
  requestId: string;
  ok?: Result;
  error?: V2Error;
};

export type SessionEffectMessage = {
  type: "session/effect";
  space: string;
  sessionId: SessionId;
  effect: SessionSync;
};

export type SessionRevokedMessage = {
  type: "session/revoked";
  space: string;
  sessionId: SessionId;
  reason: "taken-over" | "unauthorized";
};

export type V2Error = {
  name: string;
  message: string;
  precondition?: string;
  retryAfterSeq?: number;
  /**
   * Present on an `AuthorizationError` that a fresh handshake can heal — the
   * connection-challenge and invocation-freshness anti-replay races (an expired,
   * already-used, or mismatched challenge; a stale signed `exp`). Each reconnect
   * runs a new `hello` that issues a fresh challenge, so these do not recur. Its
   * absence marks a permanent denial (an audience mismatch, a malformed
   * invocation, or an ACL capability shortfall) that retrying cannot fix — the
   * client stops reopening the session and surfaces the error instead of looping.
   */
  retriable?: boolean;
};

export type V2Result<Value> = { ok: Value } | { error: V2Error };

export type ClientMessage =
  | HelloMessage
  | SessionOpenRequest
  | TransactRequest
  | GraphQueryRequest
  | EntityIdListRequest
  | EntityIdLookupRequest
  | SqliteQueryRequest
  | SqliteRegisterDiskSourceRequest
  | WatchSetRequest
  | WatchAddRequest
  | SessionAckRequest;
export type ServerMessage =
  | HelloOkMessage
  | ResponseMessage<FabricValue>
  | SessionEffectMessage
  | SessionRevokedMessage;

const memoryReconstructionContext = new EmptyReconstructionContext(
  true,
  "no cell reconstruction at the memory boundary",
);

// These ambient flags and the memory protocol flags below are catalogued, with
// their defaults and removal paths, in docs/development/EXPERIMENTAL_OPTIONS.md.
// Update that registry when adding or removing one.
let serverExecutionEnabled = false;
let commitPreconditionsEnabled = true;
let syncSchemaTableEnabled = true;
let ownWriteEchoEnabled = true;

/**
 * Ambient runtime flag for server-execution v2
 * (`EXPERIMENTAL_SERVER_EXECUTION`; docs/specs/server-side-execution/). OFF is
 * today's behavior byte-for-byte. The runner owns the feature, but the
 * per-class commit admission rows (protocol.md §2) are enforced by the memory
 * server under the flag, so the value lives beside the memory protocol flags.
 * Not a handshake capability: admission
 * enforcement is server-local, so nothing about it is negotiated per
 * connection.
 */
export function setServerExecutionConfig(enabled?: boolean): void {
  serverExecutionEnabled = enabled ?? false;
}

export function getServerExecutionConfig(): boolean {
  return serverExecutionEnabled;
}

export function resetServerExecutionConfig(): void {
  serverExecutionEnabled = false;
}

/**
 * Ambient runtime flag for commit preconditions. The runner owns the feature,
 * but the memory protocol needs the value during client/server handshakes.
 */
export function setCommitPreconditionsConfig(enabled?: boolean): void {
  commitPreconditionsEnabled = enabled ?? true;
}

export function getCommitPreconditionsConfig(): boolean {
  return commitPreconditionsEnabled;
}

export function resetCommitPreconditionsConfig(): void {
  commitPreconditionsEnabled = true;
}

/**
 * Ambient protocol capability for hash-keyed frame-local schema tables in sync
 * payloads. This is a wire-size optimization only; peers that do not advertise
 * the v2 capability keep receiving the historical fully-expanded `SessionSync`
 * shape.
 */
export function setSyncSchemaTableConfig(enabled?: boolean): void {
  syncSchemaTableEnabled = enabled ?? true;
}

export function getSyncSchemaTableConfig(): boolean {
  return syncSchemaTableEnabled;
}

export function resetSyncSchemaTableConfig(): void {
  syncSchemaTableEnabled = true;
}

/**
 * Ambient server behavior for own-write echo on sync frames (CT-1965): a
 * session's own accepted patch-produced heads ride the covering frame as full
 * post-apply documents, so promotion retires the pending overlay against
 * delivered truth instead of extrapolating merged state it never saw. Set- and
 * delete-produced heads stay elided — the client provably holds their outcome.
 * Off restores full echo suppression (the pre-CT-1965 behavior). Not a
 * protocol capability: every client generation handles the echoed frames.
 */
export function setOwnWriteEchoConfig(enabled?: boolean): void {
  ownWriteEchoEnabled = enabled ?? true;
}

export function getOwnWriteEchoConfig(): boolean {
  return ownWriteEchoEnabled;
}

export function resetOwnWriteEchoConfig(): void {
  ownWriteEchoEnabled = true;
}

export const getMemoryProtocolFlags = (): MemoryProtocolFlags => ({
  modernCellRep: getModernCellRepConfig(),
  commitPreconditions: getCommitPreconditionsConfig(),
  // A build-inherent capability, not configuration: this build's engine always
  // evaluates row-label rules at commit (sqlite/commit-eval.ts), so it always
  // advertises the fact. Peers that see it absent (an older server) keep their
  // write gate failing closed.
  sqliteCommitRowLabelEval: true,
  // Likewise build-inherent: this build's engine resolves array-localSeq
  // pending reads (resolvePendingReads), so it always advertises it. Clients
  // that see it absent scalarize to top-of-stack before sending.
  pendingReadStacks: true,
  // Likewise build-inherent: this build's server stages the catch-up
  // obligation for every verdict (accepts included), so it always
  // advertises it. Clients that see it absent apply verdicts immediately.
  verdictCatchUpMarkers: true,
  // The engine answers this request from its identifier index without
  // selecting stored entity values.
  entityIdListing: true,
  entityIdPagination: true,
  entityIdLookup: true,
  syncSchemaTableV2: getSyncSchemaTableConfig(),
});

/**
 * Commit preconditions and the other capability flags are optional
 * capabilities, not data-model wire contracts. Peers with different
 * capability flags can still share memory data; the server's flags control
 * what is accepted on that connection.
 */
export const compatibleMemoryProtocolFlags = (
  left: MemoryProtocolFlags,
  right: MemoryProtocolFlags,
): boolean => left.modernCellRep === right.modernCellRep;

/**
 * Parses and normalizes incoming wire-protocol flags. Returns `null` if the
 * input is not a recognizable flags object.
 */
export const parseMemoryProtocolFlags = (
  value: unknown,
): MemoryProtocolFlags | null => {
  if (!isRecord(value) || Array.isArray(value)) {
    return null;
  }

  const commitPreconditions = value.commitPreconditions;
  if (
    commitPreconditions !== undefined &&
    typeof commitPreconditions !== "boolean"
  ) {
    return null;
  }

  const modernCellRep = value.modernCellRep;
  if (
    modernCellRep !== undefined &&
    typeof modernCellRep !== "boolean"
  ) {
    return null;
  }

  const syncSchemaTableV2 = value.syncSchemaTableV2;
  if (
    syncSchemaTableV2 !== undefined &&
    typeof syncSchemaTableV2 !== "boolean"
  ) {
    return null;
  }

  const sqliteCommitRowLabelEval = value.sqliteCommitRowLabelEval;
  if (
    sqliteCommitRowLabelEval !== undefined &&
    typeof sqliteCommitRowLabelEval !== "boolean"
  ) {
    return null;
  }

  const pendingReadStacks = value.pendingReadStacks;
  if (
    pendingReadStacks !== undefined &&
    typeof pendingReadStacks !== "boolean"
  ) {
    return null;
  }

  const verdictCatchUpMarkers = value.verdictCatchUpMarkers;
  if (
    verdictCatchUpMarkers !== undefined &&
    typeof verdictCatchUpMarkers !== "boolean"
  ) {
    return null;
  }

  const entityIdListing = value.entityIdListing;
  if (
    entityIdListing !== undefined &&
    typeof entityIdListing !== "boolean"
  ) {
    return null;
  }

  const entityIdPagination = value.entityIdPagination;
  if (
    entityIdPagination !== undefined &&
    typeof entityIdPagination !== "boolean"
  ) {
    return null;
  }

  const entityIdLookup = value.entityIdLookup;
  if (
    entityIdLookup !== undefined &&
    typeof entityIdLookup !== "boolean"
  ) {
    return null;
  }

  return {
    modernCellRep: modernCellRep === true,
    commitPreconditions: commitPreconditions === true,
    syncSchemaTableV2: syncSchemaTableV2 === true,
    // Absent (an older peer) parses to false: the capability must be
    // POSITIVELY advertised for the runner to relax its write gate.
    sqliteCommitRowLabelEval: sqliteCommitRowLabelEval === true,
    // Absent (an older server) parses to false: clients scalarize pending
    // reads to top-of-stack unless the array capability is advertised.
    pendingReadStacks: pendingReadStacks === true,
    // Absent (an older server that stamps markers only for conflicts)
    // parses to false: clients apply verdicts immediately instead of
    // parking them on marker coverage.
    verdictCatchUpMarkers: verdictCatchUpMarkers === true,
    entityIdListing: entityIdListing === true,
    entityIdPagination: entityIdPagination === true,
    entityIdLookup: entityIdLookup === true,
  };
};

/**
 * Builds the wire-format flags object for a `hello`/`hello.ok` message.
 */
export const wireMemoryProtocolFlags = (
  flags: MemoryProtocolFlags,
): WireMemoryProtocolFlags => ({
  modernCellRep: flags.modernCellRep,
  commitPreconditions: flags.commitPreconditions,
  syncSchemaTableV2: flags.syncSchemaTableV2,
  sqliteCommitRowLabelEval: flags.sqliteCommitRowLabelEval,
  pendingReadStacks: flags.pendingReadStacks,
  verdictCatchUpMarkers: flags.verdictCatchUpMarkers,
  entityIdListing: flags.entityIdListing,
  entityIdPagination: flags.entityIdPagination,
  entityIdLookup: flags.entityIdLookup,
});

/**
 * Encodes a wire payload. The encoding embeds every string value
 * byte-verbatim (`fvj1:` tag + canonical JSON; strings self-represent, and
 * neither reserved schema-reference prefix contains a JSON-escapable
 * character). Three consumers depend on that property as a cheap substring
 * gate and must move in lockstep with any codec change (fvj2, escaping of
 * tag-like strings): the client receive-path expansion gate (v2/client.ts),
 * `containsReservedSchemaRefSubstring` (v2/sync-schema-ref.ts), and the
 * engine's commit/stored-row probes (v2/engine.ts). A pinning test in
 * test/v2-sync-schema-table.test.ts fails loudly if verbatim embedding ever
 * stops holding.
 */
export const encodeMemoryBoundary = (value: FabricValue): string =>
  jsonFromValue(value);

export const commitPreconditionValueHash = (value: FabricValue): string =>
  hashStringOf(encodeMemoryBoundary(value));

export const decodeMemoryBoundary = <Value extends FabricValue = FabricValue>(
  source: string,
): Value & FabricValue => {
  const decoded = valueFromJson(
    source,
    memoryReconstructionContext,
  );

  return decoded as Value;
};

export const toDocumentPath = (path: readonly string[]): DocumentPath =>
  path as DocumentPath;

export const toValuePath = (path: readonly string[]): ValuePath =>
  path as ValuePath;

/**
 * Builds a document-level selector (path rooted under `"value"`) from a schema
 * path selector. The result is interned-and-frozen via `internPathSelector()`,
 * to get the benefits of hash caching.
 */
export const toDocumentSelector = (
  selector: Pick<SchemaPathSelector, "path" | "schema">,
): DocumentSchemaPathSelector =>
  internPathSelector({
    ...selector,
    path: toDocumentPath(["value", ...selector.path]),
  }) as DocumentSchemaPathSelector;

export const isEntityDocument = (
  value: unknown,
): value is EntityDocument => isObject(value);

export const getEntityDocumentMetadata = (
  document: EntityDocument,
): Record<string, FabricValue> => {
  const {
    value: _value,
    ...metadata
  } = document;
  return metadata;
};
