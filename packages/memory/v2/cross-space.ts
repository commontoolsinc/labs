import type {
  BranchName,
  CellScope,
  EntityDocument,
  EntityId,
  SchedulerExecutionContextKey,
} from "../v2.ts";
import { isEntityDocument, principalOfUserContextKey } from "../v2.ts";

/**
 * Cross-space protocol substrate (C3.1, context-lattice design §5).
 *
 * The wire vocabulary and transport seam for cross-space reads: foreign
 * wake subscription, stale-reader notices, authenticated foreign point
 * reads, and authorization-epoch propagation. The seam is drawn at the
 * HOST boundary (standing decision #1, 2026-07-17): messages travel
 * between the `Server` hosts that own each space's engine — engines stay
 * passive substrate and never speak the protocol. Today's same-process
 * primitives become the protocol's first transport
 * ({@link InProcessCrossSpaceTransport}); the second is co-hosted hosts
 * over low-latency, reliable links (C3.10a), per §5's explicit assumption
 * set. Geo-distributed hosts are a later transport with its own design.
 *
 * **Module boundary (enforced by test):** this module's only relative
 * import is `../v2.ts` (the dependency-light shared wire-type module). It
 * must never import `./engine.ts`, `./server.ts`, or any other host/engine
 * internal: the protocol is defined over wire shapes, so a change to
 * engine internals can never silently change the wire contract, and no
 * protocol participant can reach around the transport into a peer engine
 * (the C3A1 in-process-accident class).
 *
 * **Versioning posture (additive-tolerant read, strict write):**
 *
 * - {@link CROSS_SPACE_PROTOCOL_VERSION} names the BREAKING-change
 *   generation. Additive evolution — new message types, new optional
 *   fields on existing types — never bumps it. A parser rejects a
 *   non-current version (`unsupported-version`): cross-version
 *   coexistence is a link-negotiation concern (C3.10a's hello), never a
 *   per-message concern.
 * - Reads are additive-tolerant: unknown fields on a known message type
 *   are ignored (dropped from the parsed value), and an unknown message
 *   type yields a distinguishable non-throwing outcome (`unknown-type`)
 *   so a dispatcher can apply link policy. This is what let C3.1b's
 *   messages ({@link ForeignObservationMirror}, {@link ForeignDirtyMark})
 *   slot in additively under v1, and what lets later fields do the same.
 * - Writes are strict: serializers validate first (fail loudly at the
 *   send site, never on the peer) and emit exactly the known field set —
 *   tolerated unknown fields never survive a round trip.
 * - Deliberate carve-outs from field tolerance, mirroring the engine's own
 *   address validator: a wire read address carrying `space`, `scopeKey`,
 *   `scope_key`, `readScopeKey`, or `writeScopeKey` is rejected, not
 *   ignored — silently dropping a smuggled space/scope-key would hide a
 *   real addressing bug.
 *
 * **Envelope:** every message carries the protocol version `v`, the
 * identity of the link it rides (`linkId`), and host-pair addressing
 * (`fromSpace`/`toSpace`). `fromSpace` is the space the emitting host
 * speaks for — the C3A13 stamp-space claim: in-process it is trivially
 * honest; C3.10a binds link identity to the space→host routing table so a
 * host may only ever stamp spaces routed to it (a stamp for a space not
 * routed to the emitting host is rejected there). `toSpace` is the space
 * whose host-side inbox the message is addressed to; routing dispatches
 * on it uniformly, so future message types inherit addressing without
 * per-type routing knowledge. `fromSpace === toSpace` is malformed — a
 * space never speaks the cross-space protocol to itself.
 *
 * **Ordering contract:** a transport delivers messages on one link in
 * send order (per-link FIFO) — that is the floor every transport MUST
 * provide, declared explicitly in
 * {@link CrossSpaceOrderingCapability#perLinkFifo} so harnesses can
 * assert it. The C3A7 slot is
 * {@link CrossSpaceOrderingCapability#receiveOrderFencing} plus
 * {@link CrossSpaceOrderingCapability#linkTopology}: if C3.8's forced
 * binary chooses the receive-order arm, it requires exactly one ordered
 * link per host pair with all C3 messages multiplexed on it and read-host
 * emissions in read-host commit order — a transport declares here whether
 * it provides that, and C3.10b states its ordering through the same
 * declaration. The topology RULING itself is C3.8's to record; this
 * module only carries the slot. The in-process transport declares (and
 * implements) the strong form, so it satisfies either arm.
 *
 * **Lifecycle / reconnect (C3A12):** the link interface carries an
 * open/close/reconnect notion even though the in-process transport
 * trivially never drops. A link has a stable `linkId` and a monotonic
 * `incarnation` that bumps on each reconnect. Consumers key DURABLE
 * per-link state — the C3A12 dirt-resync cursor (`owner_space` rows with
 * `direct_dirty_seq` greater than the cursor), subscription registrations,
 * epoch resync — by the stable `linkId` so it survives reconnects, and
 * use `incarnation` to drop state belonging to dead link incarnations
 * (the read host's job on re-establishment). The in-process
 * implementation: incarnation is always 1 and `reconnected` never fires;
 * the co-hosted transport (C3.10a/C3.10b) fires it with the bumped
 * incarnation.
 *
 * **C3.1b (2026-07-18) — the first production traffic.** The mirror
 * upsert ({@link ForeignObservationMirror}) and durable dirt
 * ({@link ForeignDirtyMark}) now ride this protocol: the `Server`'s
 * `mirrorSchedulerObservation` / `propagateSchedulerDirtyToOwnerSpaces`
 * send these messages through its {@link CrossSpaceHostRouter} instead of
 * writing into the peer engine directly, and `openEngine` gained the
 * hosted-space gate (the C3A1 blocker's fix). Two C3.1b rulings recorded
 * here because they bind the wire contract:
 *
 * - **Durable-dirt carriage: the standalone {@link ForeignDirtyMark}**
 *   (the C3A1 option-(b) arm), NOT dirt rows on
 *   {@link ForeignStaleReaders}. `ForeignStaleReaders` is demand-joined —
 *   it exists only where a subscription does (C3.3a's machinery, unwired
 *   until then) — so it structurally cannot carry the §4 parked-space
 *   obligation ("a parked home space accumulates dirt and catches up on
 *   subscribe"): a home space with no subscription would hear nothing.
 *   `ForeignDirtyMark` flows per dirtying commit regardless of
 *   subscription state, exactly like the pre-C3.1b direct write it
 *   replaces, so the parked obligation stays checkable with the
 *   in-process transport today. The option-(a) slot (dirtied-rows-on-
 *   notice + a subscribe-response dirt snapshot) remains open as an
 *   additive extension if C3.3a wants notice-coupled dirt; the durable
 *   pull source either way is the read host's `scheduler_action_state`
 *   (`owner_space` = home, `direct_dirty_seq` > cursor), and the
 *   per-link cursor (C3A12 keying: stable `linkId`) is advanced by the
 *   home host on apply — persistence + the reconnect pull are C3.10b's.
 * - **No negative-ack message.** Delivery to an unhosted `toSpace` drops
 *   at the router with a warning and zero side effects, and the sender is
 *   not told. Rationale: mirror/dirt are one-way idempotent state
 *   carriage whose loss-recovery source is durable on the read host (the
 *   dirt rows above; mirrors re-upsert on the next accepted observation),
 *   so a nack would create a new unauthenticated backchannel — who may
 *   nack whom, and what a sender may do about it — that only C3.10a's
 *   link-identity/routing-table work could make trustworthy, while no
 *   C3.1b send site could act on one anyway (the home commit is already
 *   accepted when the mirror/dirt fans out). Revisit with C3.10a if the
 *   co-hosted link wants delivery diagnostics.
 */

/**
 * Breaking-change generation of the cross-space wire protocol. Additive
 * evolution (new message types, new optional fields) never bumps this —
 * see the module docblock's versioning posture.
 */
export const CROSS_SPACE_PROTOCOL_VERSION = 1;

/**
 * Envelope fields every cross-space message carries. See the module
 * docblock for the `fromSpace`/`toSpace` addressing and stamp-space
 * semantics.
 */
export interface CrossSpaceEnvelope {
  /** Protocol breaking-change generation ({@link CROSS_SPACE_PROTOCOL_VERSION}). */
  v: number;
  /** Identity of the link (multiplexed host-pair channel) this message rides. */
  linkId: string;
  /** Space the emitting host speaks for (the C3A13 stamp-space claim). */
  fromSpace: string;
  /** Space whose host-side inbox this message is addressed to. */
  toSpace: string;
}

/**
 * One per-lane demand pair, mirroring the A4 wake-lookup shape the home
 * host builds in `#publishAcceptedCommit`: the space lane against the
 * union of all branch demand, plus every OPEN lane grant of either rank
 * (user AND session — the post-C2.7 shape) against its own demand slice.
 */
export interface CrossSpaceLaneDemand {
  contextKey: SchedulerExecutionContextKey;
  /** Canonical scheduler piece ids (opaque to the protocol). */
  pieces: readonly string[];
}

/**
 * Home host → read host: register (or re-register) the home space's
 * demand-joined foreign-reader interest with the read space's host.
 *
 * `branch` is the HOME branch whose demand this subscription mirrors
 * (decision #4: v1 pairs it with the read space's DEFAULT branch only).
 * The demanded piece ids ride as the space-lane pair — `laneDemands[0]`
 * is required to be the `"space"` entry (A4 builds it first), so the
 * union can never skew from a separately-carried copy; use
 * {@link demandedPieceIdsOfSubscribe}. `subscriptionGeneration` is the
 * C3A10 re-register barrier's generation: monotonic per
 * (homeSpace, readSpace, branch) subscription stream, a subscribe with a
 * higher generation supersedes lower ones. The two-part ack/drain barrier
 * semantics are C3.3a's; this message only carries the generation.
 */
export interface ForeignReadersSubscribe extends CrossSpaceEnvelope {
  type: "foreign-readers.subscribe";
  branch: BranchName;
  laneDemands: readonly CrossSpaceLaneDemand[];
  subscriptionGeneration: number;
}

/**
 * Home host → read host: drop the home space's subscription for `branch`.
 * Carries the generation it retires so a reordered/stale unsubscribe is
 * discriminable by the receiver (C3.3a owns the exact supersession rule).
 */
export interface ForeignReadersUnsubscribe extends CrossSpaceEnvelope {
  type: "foreign-readers.unsubscribe";
  branch: BranchName;
  subscriptionGeneration: number;
}

/**
 * Read host → home host: the C3A10 ack — `branch`'s subscription at
 * `subscriptionGeneration` is APPLIED on the read host, and every
 * post-commit side effect for commits the read host had accepted before
 * applying it has drained (in-process: the read space's side-effect
 * chain; co-hosted: the corresponding dirt/notice frames precede this
 * ack on the same FIFO link). C3.3a chose a DEDICATED ack message
 * (2026-07-18) over "the first notice at gen N+1" because a notice
 * carries no generation, only exists when a commit matches (a quiet
 * read space would never ack), and delivery-does-not-await-handlers
 * means only an application-emitted message can order behind the drain.
 * The home host completes its direct-dirty-∩-demand scan with pool wake
 * only after processing this message (the barrier's second half).
 */
export interface ForeignReadersSubscribeApplied extends CrossSpaceEnvelope {
  type: "foreign-readers.subscribe-applied";
  branch: BranchName;
  subscriptionGeneration: number;
}

/**
 * Identity of one matched foreign reader — a mirrored reader row in the
 * committing (read) space whose owner is the home space. `branch` is the
 * mirrored row's branch (today the home branch stamped at mirror time),
 * carried per reader so the home host can group its direct-dirty marks.
 */
export interface ForeignReaderIdentity {
  branch: BranchName;
  pieceId: string;
  processGeneration: number;
  actionId: string;
  executionContextKey: SchedulerExecutionContextKey;
}

/**
 * Read (committing) host → home host: a commit in the read space matched
 * the home space's subscribed demand. Carries the read-space commit seq
 * and the matched reader identities. `branch` is the COMMITTING space's
 * branch of that commit. An empty `readers` list is well-formed (a
 * no-match notice is a semantic no-op). Executor-plane only: this message
 * has no session-delivery leg (C3A24). C3.1b's durable-dirt carriage
 * deliberately does NOT ride here — see {@link ForeignDirtyMark} and the
 * module docblock's option-(b) ruling; the option-(a) slot (dirt rows on
 * this notice) stays open as an additive extension.
 */
export interface ForeignStaleReaders extends CrossSpaceEnvelope {
  type: "foreign-stale-readers";
  branch: BranchName;
  commitSeq: number;
  readers: readonly ForeignReaderIdentity[];
}

/**
 * The scope context a mirrored observation was accepted under on the home
 * host — the sponsor principal and scope-anchoring session the home
 * accept transaction resolved (captured BEFORE the accepted commit; the
 * emitting host never re-derives it after the fact). The applying host
 * feeds it verbatim to its engine's mirrored-observation upsert.
 */
export interface ForeignObservationScopeContext {
  principal: string;
  sessionId: string;
}

/**
 * Home (owner) host → read host: upsert the home space's accepted
 * scheduler observation into the read space's engine as a mirrored
 * foreign-reader row set (C3.1b — the wire form of what
 * `upsertMirroredSchedulerObservation` consumes). The home space is the
 * envelope's `fromSpace`, the read space the envelope's `toSpace` —
 * payloads carry no home/read space fields.
 *
 * Mirrors are UPSERT-ONLY: the pre-C3.1b mechanism has no removal call,
 * and none is invented here. The `previousReadSpaces` drop path
 * (retraction after an observation stops reading a space) is carried by
 * this same message: the narrowed observation's payload no longer names
 * the read space, so the receiving engine's read-row reconciliation
 * deletes the stale index rows. A separate removal/tombstone message
 * would be a C3.3b/C3A6 extension (revocation cleanup), not a C3.1b one.
 *
 * - `branch`/`observedAtSeq` are the home commit's branch and seq; the
 *   seq doubles as the receiving engine's persisted last-writer fence
 *   against delayed fan-out (an older mirror never overwrites a newer
 *   one). `observedAtSeq` may be 0: an operations-empty home commit
 *   carries seq 0.
 * - `originExecutionContextKey` is the effective execution context the
 *   home (owner) transaction resolved — trusted server fan-out must not
 *   re-broaden or re-narrow ownership per mirror, so it rides explicitly
 *   and never inside the observation payload (see the carve-outs).
 * - `writerSessionId` is the canonical commit-session key of the writing
 *   session (replay/echo provenance). C3.1b mirrors are session-authored
 *   by construction; the executor-authored writer key is C3.3b's to
 *   define.
 * - `observation` is the accepted observation as a JSON-clean record. The
 *   protocol validates its structure only shallowly (this module cannot
 *   import the engine's validator — module boundary); the applying host
 *   validates it with the engine's own `schedulerObservationFromValue`
 *   and drops the message, with zero side effects, if it does not parse.
 *   Deliberate carve-outs (rejected, not ignored, mirroring the address
 *   rule): `executionContextKey`/`execution_context_key` (context rides
 *   `originExecutionContextKey`), `executionClaimAssertion` /
 *   `executionUnservedAttempt` (transient protocol-boundary fields the
 *   accepted form has stripped), and `ownerSpace`, when present, must
 *   equal the envelope's `fromSpace` (a host mirrors only observations of
 *   the space it speaks for — the C3A13 discipline).
 */
export interface ForeignObservationMirror extends CrossSpaceEnvelope {
  type: "foreign-observation.mirror";
  branch: BranchName;
  observedAtSeq: number;
  originExecutionContextKey: SchedulerExecutionContextKey;
  scopeContext: ForeignObservationScopeContext;
  writerSessionId: string;
  observation: Record<string, unknown>;
}

/**
 * Read (committing) host → home host: a commit in the read space dirtied
 * mirrored reader rows owned by the home space — the C3.1b durable-dirt
 * carriage (the C3A1 option-(b) standalone message; see the module
 * docblock for why not dirt-on-notice). The home host applies
 * `markSchedulerActionsDirectDirty` for the carried reader identities on
 * receipt. Flows per dirtying commit, independent of any subscription —
 * that independence is what carries the §4 parked-space obligation.
 *
 * - `branch` is the COMMITTING space's branch of the dirtying commit;
 *   `dirtySeq` its commit seq — a READ-SPACE-domain value, exactly what
 *   the pre-C3.1b direct write recorded (the cross-seq-domain cause
 *   consumption this implies is C3A16's, fixed by C3.5's vector; do not
 *   reinterpret it here).
 * - `readers` are the dirtied rows' action identities. Their
 *   `ownerSpace` is the envelope's `toSpace` (payloads carry no space
 *   fields); the identity fields are exactly what the dirty path consumes
 *   ({@link ForeignReaderIdentity}). An empty list is a well-formed
 *   no-op.
 * - Idempotent and reorder-safe by construction: the receiving engine
 *   max-merges `direct_dirty_seq`, so redelivery or reordering never
 *   regresses dirt. The home host advances an in-memory per-link applied-
 *   dirt cursor (keyed by stable `linkId`, C3A12) as marks apply;
 *   persisting it and the reconnect resync pull against the read host's
 *   `scheduler_action_state` rows are C3.10b's.
 */
export interface ForeignDirtyMark extends CrossSpaceEnvelope {
  type: "foreign-dirty-mark";
  branch: BranchName;
  dirtySeq: number;
  readers: readonly ForeignReaderIdentity[];
}

/**
 * Wire address of a foreign point read: the read-space document address
 * including the DECLARED scope. The target space is the envelope's
 * `toSpace` (one space field per message — an address smuggling its own
 * `space` is rejected, see the module docblock's carve-outs). No branch
 * field: v1 reads resolve against the read space's default branch
 * (decision #4); a branch selector would be an additive extension.
 */
export interface CrossSpacePointReadAddress {
  id: EntityId;
  scope?: CellScope;
  path: readonly string[];
}

/**
 * Reference to the acting principal a foreign point read runs under —
 * an identity claim plus the home-side authority it was resolved from,
 * NEVER raw credentials (no tokens, no signatures ride this message; the
 * trust model is host-level per C3A13). The home host resolves the
 * principal from LIVE authority before forwarding (C3A4, C3.4's row);
 * the read host runs its ACL check for this principal (C3.4).
 */
export interface ForeignActingPrincipalRef {
  /** The acting principal's DID. */
  principal: string;
  /** Home-side lane the attempt acts under (space/user/session rank). */
  contextKey: SchedulerExecutionContextKey;
  /**
   * The claimed action's identity + generations, for audit and for the
   * read host's deny diagnostics. Optional: the in-process transport is
   * same-host, and C3.4 owns whether its forwarding always attaches it.
   */
  claim?: {
    pieceId: string;
    actionId: string;
    leaseGeneration: number;
    claimGeneration: number;
  };
}

/**
 * Home host → read host: an authenticated foreign point read under the
 * acting context. Request/response correlate by `requestId` (unique per
 * link by the issuer's discipline).
 */
export interface ForeignPointRead extends CrossSpaceEnvelope {
  type: "foreign-point-read";
  requestId: string;
  address: CrossSpacePointReadAddress;
  actingPrincipal: ForeignActingPrincipalRef;
}

/**
 * An authorization-epoch stamp: the (space, principal) generation C3.2's
 * table carries. Bound epochs revalidate by EQUALITY and an unknown
 * (space, principal) epoch fails closed (C3A3) — this module only
 * carries the stamp shape those rules bind. On a point-read result the
 * stamp's `space` must equal the envelope's `fromSpace`: a host stamps
 * only spaces it speaks for (structural half of C3A13; the routing-table
 * half — verifying `fromSpace` against link identity — is C3.10a's).
 */
export interface ForeignAuthorizationEpochStamp {
  space: string;
  principal: string;
  epoch: number;
}

/**
 * Read host → home host: the point-read response. `served` carries the
 * resolved read-space seq, the resolved branch (v1: the read space's
 * default branch), the document snapshot (or null for absent/deleted),
 * and the authorization-epoch stamp for the acting principal. `denied`
 * is an authorization rejection; `failed` is any non-authorization
 * failure — the distinction is load-bearing for fail-closed handling.
 * C3.4 owns the `code` vocabulary (constant C1.3 fence-cause shapes).
 */
export interface ForeignPointReadResult extends CrossSpaceEnvelope {
  type: "foreign-point-read.result";
  requestId: string;
  result:
    | {
      status: "served";
      seq: number;
      branch: BranchName;
      document: EntityDocument | null;
      authorizationEpoch: ForeignAuthorizationEpochStamp;
    }
    | { status: "denied"; code: string }
    | { status: "failed"; code: string };
}

/**
 * Authority (read) host → home host: an authorization-epoch bump for the
 * emitting host's own space (`fromSpace` is the bumped space). Targets a
 * single principal or the space-wide epoch floor — the floor bumps on
 * EVERY ACL validity-state transition per C3A3 (C3.2 owns the bump rule;
 * this message only carries it).
 */
export interface ForeignAuthorizationEpochBump extends CrossSpaceEnvelope {
  type: "foreign-authorization-epoch.bump";
  target:
    | { kind: "principal"; principal: string }
    | { kind: "floor" };
  epoch: number;
}

/**
 * Home host → authority host: query the (space, principal) epoch table
 * of the queried space (`toSpace`). C3A12 pinned this as a wire message:
 * reconnect resyncs the epoch table over the link before any claim
 * re-issuance. `principals` narrows the query; absent means "everything
 * you have" (floor plus all known per-principal entries).
 */
export interface ForeignAuthorizationEpochQuery extends CrossSpaceEnvelope {
  type: "foreign-authorization-epoch.query";
  requestId: string;
  principals?: readonly string[];
}

/**
 * Authority host → home host: the epoch-query response. `epochFloor` is
 * the space-wide floor (0 at genesis); `epochs` lists known
 * per-principal entries. A principal absent here is UNKNOWN to the
 * authority — under C3A3's comparison discipline the consumer fails
 * closed on it, so an authority restart over-revokes, never
 * under-revokes (C3.2 owns those semantics).
 */
export interface ForeignAuthorizationEpochQueryResult
  extends CrossSpaceEnvelope {
  type: "foreign-authorization-epoch.query.result";
  requestId: string;
  epochFloor: number;
  epochs: readonly { principal: string; epoch: number }[];
}

/**
 * C3.10b (2026-07-18): a general cross-host APPLY barrier. The sender
 * emits `foreign-link-sync` to a peer space; the peer queues the ack on
 * that space's inbound apply chain (so it drains strictly AFTER every
 * frame that preceded the sync on the FIFO link has been applied) and
 * replies `foreign-link-sync.ack`. When the ack returns, the sender
 * knows every prior frame it sent on this link toward that space is
 * APPLIED on the peer — the cross-host equivalent of the same-host
 * `settleCrossSpaceDeliveries` barrier the in-process transport got for
 * free (C3.10a's recorded L1 leak: over the link a mirror frame is in
 * flight when the transact resolves). `requestId` correlates the pair.
 */
export interface ForeignLinkSync extends CrossSpaceEnvelope {
  type: "foreign-link-sync";
  requestId: string;
}

/** Peer → sender: the {@link ForeignLinkSync} ack (see there). */
export interface ForeignLinkSyncAck extends CrossSpaceEnvelope {
  type: "foreign-link-sync.ack";
  requestId: string;
}

/**
 * C3.10b reconnect dirt resync (C3A12 b): home host → read host, on link
 * re-establishment, pull the dirt the home missed during the outage.
 * `cursorSeq` is the home's durable per-link applied-dirt cursor (the
 * highest `direct_dirty_seq` it applied for this (link, read space, home
 * space) before the loss); the read host answers with the mirrored
 * reader rows it owns for this home space whose `direct_dirty_seq`
 * strictly exceeds it. `requestId` correlates the response barrier.
 */
export interface ForeignDirtyResync extends CrossSpaceEnvelope {
  type: "foreign-dirty-resync";
  requestId: string;
  cursorSeq: number;
}

/**
 * Read host → home host: the {@link ForeignDirtyResync} answer. `readers`
 * are the mirrored reader identities (owner = the home space) dirtied
 * past the home's cursor; `throughSeq` is the highest `direct_dirty_seq`
 * scanned (0 when nothing was missed) — the home advances its applied-
 * dirt cursor to it and marks the readers durably dirty, so the
 * re-register barrier's post-ack scan wakes them exactly once. Idempotent
 * and reorder-safe: the home's max-merge on `direct_dirty_seq` and the
 * cursor advance never regress.
 */
export interface ForeignDirtyResyncResult extends CrossSpaceEnvelope {
  type: "foreign-dirty-resync.result";
  requestId: string;
  readers: readonly ForeignReaderIdentity[];
  throughSeq: number;
}

/** Every cross-space wire message (C3.1 vocabulary + C3.1b carriage). */
export type CrossSpaceMessage =
  | ForeignReadersSubscribe
  | ForeignReadersUnsubscribe
  | ForeignReadersSubscribeApplied
  | ForeignStaleReaders
  | ForeignObservationMirror
  | ForeignDirtyMark
  | ForeignPointRead
  | ForeignPointReadResult
  | ForeignAuthorizationEpochBump
  | ForeignAuthorizationEpochQuery
  | ForeignAuthorizationEpochQueryResult
  | ForeignLinkSync
  | ForeignLinkSyncAck
  | ForeignDirtyResync
  | ForeignDirtyResyncResult;

export type CrossSpaceMessageType = CrossSpaceMessage["type"];

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K>
  : never;

/**
 * A message as callers hand it to an endpoint's `send`: the typed body
 * without envelope fields. The endpoint stamps `v`, `linkId`,
 * `fromSpace`, and `toSpace` itself, so a caller can neither mis-version
 * nor misroute a message.
 */
export type CrossSpaceMessageInit = DistributiveOmit<
  CrossSpaceMessage,
  keyof CrossSpaceEnvelope
>;

/** The demanded piece ids of a subscribe — its required space-lane pair. */
export const demandedPieceIdsOfSubscribe = (
  message: Pick<ForeignReadersSubscribe, "laneDemands">,
): readonly string[] => message.laneDemands[0]?.pieces ?? [];

/**
 * Parse outcome. `unknown-type` and `unsupported-version` are
 * distinguishable from `malformed-*` so a dispatcher can apply link
 * policy to additive evolution without treating it as corruption.
 */
export type CrossSpaceParseResult =
  | { ok: true; message: CrossSpaceMessage }
  | {
    ok: false;
    error:
      | "malformed-json"
      | "malformed-envelope"
      | "unsupported-version"
      | "unknown-type"
      | "malformed-message";
    detail: string;
    type?: string;
    v?: number;
  };

export class CrossSpaceProtocolError extends Error {
  constructor(
    readonly code:
      | "malformed-message"
      | "link-closed"
      | "router-closed"
      | "space-not-hosted"
      | "space-already-registered"
      | "self-link",
    message: string,
  ) {
    super(message);
    this.name = "CrossSpaceProtocolError";
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const isBranchName = (value: unknown): value is BranchName =>
  typeof value === "string";

const isNonNegativeSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isPositiveSafeInteger = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

const isExecutionContextKey = (
  value: unknown,
): value is SchedulerExecutionContextKey =>
  value === "space" ||
  (typeof value === "string" &&
    (principalOfUserContextKey(value) !== undefined ||
      /^session:[^:]+:[^:]+$/.test(value)));

const isStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every((entry) => typeof entry === "string");

const isNonEmptyStringArray = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.every(isNonEmptyString);

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value as Record<string, unknown>)) {
      deepFreeze(entry);
    }
    Object.freeze(value);
  }
  return value;
};

/**
 * Per-type payload readers. A reader validates the payload fields of a
 * raw record and returns the STRICT field pick (exactly the known
 * fields) or an error detail string. Parse and encode share these, so a
 * value the encoder emits is a value the parser accepts by construction,
 * and tolerated unknown fields never survive either direction.
 */
type PayloadReader = (
  raw: Record<string, unknown>,
) => { fields: Record<string, unknown> } | { detail: string };

const readLaneDemands = (
  value: unknown,
):
  | { laneDemands: CrossSpaceLaneDemand[] }
  | { detail: string } => {
  if (!Array.isArray(value) || value.length === 0) {
    return { detail: "laneDemands must be a non-empty array" };
  }
  const seen = new Set<string>();
  const laneDemands: CrossSpaceLaneDemand[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      return { detail: `laneDemands[${index}] must be a record` };
    }
    if (!isExecutionContextKey(entry.contextKey)) {
      return {
        detail: `laneDemands[${index}].contextKey must be a canonical ` +
          "execution context key",
      };
    }
    if (index === 0 && entry.contextKey !== "space") {
      return {
        detail: "laneDemands[0] must be the space-lane pair (A4 order): " +
          "it carries the demanded piece ids",
      };
    }
    if (index > 0 && entry.contextKey === "space") {
      return { detail: "laneDemands carries exactly one space-lane pair" };
    }
    if (seen.has(entry.contextKey)) {
      return {
        detail: `laneDemands repeats context key ${entry.contextKey}`,
      };
    }
    seen.add(entry.contextKey);
    if (!isNonEmptyStringArray(entry.pieces)) {
      return {
        detail: `laneDemands[${index}].pieces must be an array of piece ids`,
      };
    }
    laneDemands.push({
      contextKey: entry.contextKey,
      pieces: [...entry.pieces],
    });
  }
  return { laneDemands };
};

const readReaderIdentities = (
  value: unknown,
):
  | { readers: ForeignReaderIdentity[] }
  | { detail: string } => {
  if (!Array.isArray(value)) {
    return { detail: "readers must be an array" };
  }
  const readers: ForeignReaderIdentity[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) {
      return { detail: `readers[${index}] must be a record` };
    }
    if (!isBranchName(entry.branch)) {
      return { detail: `readers[${index}].branch must be a string` };
    }
    if (!isNonEmptyString(entry.pieceId)) {
      return { detail: `readers[${index}].pieceId must be a piece id` };
    }
    if (!isNonNegativeSafeInteger(entry.processGeneration)) {
      return {
        detail: `readers[${index}].processGeneration must be a ` +
          "non-negative integer",
      };
    }
    if (!isNonEmptyString(entry.actionId)) {
      return { detail: `readers[${index}].actionId must be an action id` };
    }
    if (!isExecutionContextKey(entry.executionContextKey)) {
      return {
        detail: `readers[${index}].executionContextKey must be a ` +
          "canonical execution context key",
      };
    }
    readers.push({
      branch: entry.branch,
      pieceId: entry.pieceId,
      processGeneration: entry.processGeneration,
      actionId: entry.actionId,
      executionContextKey: entry.executionContextKey,
    });
  }
  return { readers };
};

/**
 * Deliberate carve-out keys a wire read address must not carry (see the
 * module docblock): the target space rides the envelope, and scope keys
 * are host-resolved, never wire-asserted — mirroring the engine's own
 * observation-address validator.
 */
const FORBIDDEN_ADDRESS_KEYS = [
  "space",
  "scopeKey",
  "scope_key",
  "readScopeKey",
  "writeScopeKey",
] as const;

const readPointReadAddress = (
  value: unknown,
):
  | { address: CrossSpacePointReadAddress }
  | { detail: string } => {
  if (!isRecord(value)) {
    return { detail: "address must be a record" };
  }
  for (const key of FORBIDDEN_ADDRESS_KEYS) {
    if (key in value) {
      return {
        detail: `address must not carry "${key}" — the read space is the ` +
          "envelope's toSpace and scope keys are host-resolved",
      };
    }
  }
  if (!isNonEmptyString(value.id)) {
    return { detail: "address.id must be a document id" };
  }
  if (
    value.scope !== undefined && value.scope !== "space" &&
    value.scope !== "user" && value.scope !== "session"
  ) {
    return { detail: "address.scope must be a declared cell scope" };
  }
  if (!isStringArray(value.path)) {
    return { detail: "address.path must be an array of strings" };
  }
  const address: CrossSpacePointReadAddress = {
    id: value.id,
    ...(value.scope !== undefined ? { scope: value.scope } : {}),
    path: [...value.path],
  };
  return { address };
};

const readActingPrincipal = (
  value: unknown,
):
  | { actingPrincipal: ForeignActingPrincipalRef }
  | { detail: string } => {
  if (!isRecord(value)) {
    return { detail: "actingPrincipal must be a record" };
  }
  if (!isNonEmptyString(value.principal)) {
    return { detail: "actingPrincipal.principal must be a principal DID" };
  }
  if (!isExecutionContextKey(value.contextKey)) {
    return {
      detail: "actingPrincipal.contextKey must be a canonical execution " +
        "context key",
    };
  }
  let claim: ForeignActingPrincipalRef["claim"];
  if (value.claim !== undefined) {
    if (!isRecord(value.claim)) {
      return { detail: "actingPrincipal.claim must be a record" };
    }
    if (
      !isNonEmptyString(value.claim.pieceId) ||
      !isNonEmptyString(value.claim.actionId) ||
      !isPositiveSafeInteger(value.claim.leaseGeneration) ||
      !isPositiveSafeInteger(value.claim.claimGeneration)
    ) {
      return {
        detail: "actingPrincipal.claim must carry pieceId, actionId, and " +
          "positive lease/claim generations",
      };
    }
    claim = {
      pieceId: value.claim.pieceId,
      actionId: value.claim.actionId,
      leaseGeneration: value.claim.leaseGeneration,
      claimGeneration: value.claim.claimGeneration,
    };
  }
  return {
    actingPrincipal: {
      principal: value.principal,
      contextKey: value.contextKey,
      ...(claim !== undefined ? { claim } : {}),
    },
  };
};

/**
 * Deliberate carve-out keys a mirrored observation payload must not carry
 * (see {@link ForeignObservationMirror}): the trusted execution context
 * rides `originExecutionContextKey`, and claim-assertion/unserved markers
 * are transient protocol-boundary fields the accepted form has stripped —
 * a payload smuggling any of them is rejected, not silently ignored.
 */
const FORBIDDEN_MIRROR_OBSERVATION_KEYS = [
  "executionContextKey",
  "execution_context_key",
  "executionClaimAssertion",
  "executionUnservedAttempt",
] as const;

/**
 * Shallow-validate a mirrored observation payload: the record shape, the
 * carve-outs, the `ownerSpace`↔`fromSpace` consistency rule, and the row-
 * keying identity scalars. Everything else stays opaque — full semantic
 * validation is the APPLYING host's, via the engine's own observation
 * validator (this module must not import it — module boundary). The
 * returned value is a JSON round-trip clone: eager wire semantics, and
 * the encoder never aliases (or deep-freezes) the sender's live object.
 */
const readMirrorObservation = (
  value: unknown,
  fromSpace: unknown,
):
  | { observation: Record<string, unknown> }
  | { detail: string } => {
  if (!isRecord(value)) {
    return { detail: "observation must be a record" };
  }
  for (const key of FORBIDDEN_MIRROR_OBSERVATION_KEYS) {
    if (key in value) {
      return {
        detail: `observation must not carry "${key}" — the trusted ` +
          "context rides originExecutionContextKey and claim-assertion " +
          "fields never survive acceptance",
      };
    }
  }
  if (value.ownerSpace !== undefined && value.ownerSpace !== fromSpace) {
    return {
      detail: "observation.ownerSpace, when present, must equal the " +
        "envelope's fromSpace — a host mirrors only observations of the " +
        "space it speaks for (C3A13)",
    };
  }
  if (!isNonEmptyString(value.pieceId)) {
    return { detail: "observation.pieceId must be a piece id" };
  }
  if (!isNonEmptyString(value.actionId)) {
    return { detail: "observation.actionId must be an action id" };
  }
  if (!isNonNegativeSafeInteger(value.processGeneration)) {
    return {
      detail: "observation.processGeneration must be a non-negative integer",
    };
  }
  return {
    observation: JSON.parse(JSON.stringify(value)) as Record<string, unknown>,
  };
};

const readMirrorScopeContext = (
  value: unknown,
):
  | { scopeContext: ForeignObservationScopeContext }
  | { detail: string } => {
  if (!isRecord(value)) {
    return { detail: "scopeContext must be a record" };
  }
  if (!isNonEmptyString(value.principal)) {
    return { detail: "scopeContext.principal must be a principal DID" };
  }
  if (!isNonEmptyString(value.sessionId)) {
    return { detail: "scopeContext.sessionId must be a session id" };
  }
  return {
    scopeContext: { principal: value.principal, sessionId: value.sessionId },
  };
};

const PAYLOAD_READERS: Record<CrossSpaceMessageType, PayloadReader> = {
  "foreign-readers.subscribe": (raw) => {
    if (!isBranchName(raw.branch)) {
      return { detail: "branch must be a string" };
    }
    const lanes = readLaneDemands(raw.laneDemands);
    if ("detail" in lanes) return lanes;
    if (!isPositiveSafeInteger(raw.subscriptionGeneration)) {
      return {
        detail: "subscriptionGeneration must be a positive integer",
      };
    }
    return {
      fields: {
        branch: raw.branch,
        laneDemands: lanes.laneDemands,
        subscriptionGeneration: raw.subscriptionGeneration,
      },
    };
  },
  "foreign-readers.unsubscribe": (raw) => {
    if (!isBranchName(raw.branch)) {
      return { detail: "branch must be a string" };
    }
    if (!isPositiveSafeInteger(raw.subscriptionGeneration)) {
      return {
        detail: "subscriptionGeneration must be a positive integer",
      };
    }
    return {
      fields: {
        branch: raw.branch,
        subscriptionGeneration: raw.subscriptionGeneration,
      },
    };
  },
  "foreign-readers.subscribe-applied": (raw) => {
    if (!isBranchName(raw.branch)) {
      return { detail: "branch must be a string" };
    }
    if (!isPositiveSafeInteger(raw.subscriptionGeneration)) {
      return {
        detail: "subscriptionGeneration must be a positive integer",
      };
    }
    return {
      fields: {
        branch: raw.branch,
        subscriptionGeneration: raw.subscriptionGeneration,
      },
    };
  },
  "foreign-stale-readers": (raw) => {
    if (!isBranchName(raw.branch)) {
      return { detail: "branch must be a string" };
    }
    if (!isPositiveSafeInteger(raw.commitSeq)) {
      return { detail: "commitSeq must be a positive integer" };
    }
    const readers = readReaderIdentities(raw.readers);
    if ("detail" in readers) return readers;
    return {
      fields: {
        branch: raw.branch,
        commitSeq: raw.commitSeq,
        readers: readers.readers,
      },
    };
  },
  "foreign-observation.mirror": (raw) => {
    if (!isBranchName(raw.branch)) {
      return { detail: "branch must be a string" };
    }
    // 0 is legitimate: an operations-empty home commit carries seq 0.
    if (!isNonNegativeSafeInteger(raw.observedAtSeq)) {
      return { detail: "observedAtSeq must be a non-negative integer" };
    }
    if (!isExecutionContextKey(raw.originExecutionContextKey)) {
      return {
        detail: "originExecutionContextKey must be a canonical execution " +
          "context key",
      };
    }
    const scope = readMirrorScopeContext(raw.scopeContext);
    if ("detail" in scope) return scope;
    if (!isNonEmptyString(raw.writerSessionId)) {
      return {
        detail: "writerSessionId must be a canonical commit-session key",
      };
    }
    const observation = readMirrorObservation(raw.observation, raw.fromSpace);
    if ("detail" in observation) return observation;
    return {
      fields: {
        branch: raw.branch,
        observedAtSeq: raw.observedAtSeq,
        originExecutionContextKey: raw.originExecutionContextKey,
        scopeContext: scope.scopeContext,
        writerSessionId: raw.writerSessionId,
        observation: observation.observation,
      },
    };
  },
  "foreign-dirty-mark": (raw) => {
    if (!isBranchName(raw.branch)) {
      return { detail: "branch must be a string" };
    }
    // The engine's cause recorder requires a positive seq; a dirtying
    // commit always has one (only operations-empty commits carry 0, and
    // those dirty nothing).
    if (!isPositiveSafeInteger(raw.dirtySeq)) {
      return { detail: "dirtySeq must be a positive integer" };
    }
    const readers = readReaderIdentities(raw.readers);
    if ("detail" in readers) return readers;
    return {
      fields: {
        branch: raw.branch,
        dirtySeq: raw.dirtySeq,
        readers: readers.readers,
      },
    };
  },
  "foreign-point-read": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    const address = readPointReadAddress(raw.address);
    if ("detail" in address) return address;
    const acting = readActingPrincipal(raw.actingPrincipal);
    if ("detail" in acting) return acting;
    return {
      fields: {
        requestId: raw.requestId,
        address: address.address,
        actingPrincipal: acting.actingPrincipal,
      },
    };
  },
  "foreign-point-read.result": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    if (!isRecord(raw.result)) {
      return { detail: "result must be a record" };
    }
    const result = raw.result;
    if (result.status === "served") {
      if (!isPositiveSafeInteger(result.seq)) {
        return { detail: "result.seq must be a positive integer" };
      }
      if (!isBranchName(result.branch)) {
        return { detail: "result.branch must be a string" };
      }
      if (result.document !== null && !isEntityDocument(result.document)) {
        return { detail: "result.document must be a document or null" };
      }
      const stamp = result.authorizationEpoch;
      if (
        !isRecord(stamp) || !isNonEmptyString(stamp.space) ||
        !isNonEmptyString(stamp.principal) ||
        !isNonNegativeSafeInteger(stamp.epoch)
      ) {
        return {
          detail: "result.authorizationEpoch must carry space, principal, " +
            "and a non-negative epoch",
        };
      }
      if (stamp.space !== raw.fromSpace) {
        return {
          detail: "result.authorizationEpoch.space must equal the " +
            "envelope's fromSpace — a host stamps only spaces it speaks " +
            "for (C3A13)",
        };
      }
      return {
        fields: {
          requestId: raw.requestId,
          result: {
            status: "served",
            seq: result.seq,
            branch: result.branch,
            document: result.document as EntityDocument | null,
            authorizationEpoch: {
              space: stamp.space,
              principal: stamp.principal,
              epoch: stamp.epoch,
            },
          },
        },
      };
    }
    if (result.status === "denied" || result.status === "failed") {
      if (!isNonEmptyString(result.code)) {
        return { detail: "result.code must be a non-empty string" };
      }
      return {
        fields: {
          requestId: raw.requestId,
          result: { status: result.status, code: result.code },
        },
      };
    }
    return {
      detail: 'result.status must be "served", "denied", or "failed"',
    };
  },
  "foreign-authorization-epoch.bump": (raw) => {
    if (!isRecord(raw.target)) {
      return { detail: "target must be a record" };
    }
    let target: ForeignAuthorizationEpochBump["target"];
    if (raw.target.kind === "principal") {
      if (!isNonEmptyString(raw.target.principal)) {
        return { detail: "target.principal must be a principal DID" };
      }
      target = { kind: "principal", principal: raw.target.principal };
    } else if (raw.target.kind === "floor") {
      target = { kind: "floor" };
    } else {
      return { detail: 'target.kind must be "principal" or "floor"' };
    }
    if (!isNonNegativeSafeInteger(raw.epoch)) {
      return { detail: "epoch must be a non-negative integer" };
    }
    return { fields: { target, epoch: raw.epoch } };
  },
  "foreign-authorization-epoch.query": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    if (
      raw.principals !== undefined &&
      !isNonEmptyStringArray(raw.principals)
    ) {
      return {
        detail: "principals must be an array of principal DIDs when present",
      };
    }
    return {
      fields: {
        requestId: raw.requestId,
        ...(raw.principals !== undefined
          ? { principals: [...(raw.principals as readonly string[])] }
          : {}),
      },
    };
  },
  "foreign-authorization-epoch.query.result": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    if (!isNonNegativeSafeInteger(raw.epochFloor)) {
      return { detail: "epochFloor must be a non-negative integer" };
    }
    if (!Array.isArray(raw.epochs)) {
      return { detail: "epochs must be an array" };
    }
    const epochs: { principal: string; epoch: number }[] = [];
    for (const [index, entry] of raw.epochs.entries()) {
      if (
        !isRecord(entry) || !isNonEmptyString(entry.principal) ||
        !isNonNegativeSafeInteger(entry.epoch)
      ) {
        return {
          detail: `epochs[${index}] must carry a principal and a ` +
            "non-negative epoch",
        };
      }
      epochs.push({ principal: entry.principal, epoch: entry.epoch });
    }
    return {
      fields: {
        requestId: raw.requestId,
        epochFloor: raw.epochFloor,
        epochs,
      },
    };
  },
  "foreign-link-sync": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    return { fields: { requestId: raw.requestId } };
  },
  "foreign-link-sync.ack": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    return { fields: { requestId: raw.requestId } };
  },
  "foreign-dirty-resync": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    // 0 is legitimate: a home that applied no dirt for this link before the
    // loss pulls everything the read host owns.
    if (!isNonNegativeSafeInteger(raw.cursorSeq)) {
      return { detail: "cursorSeq must be a non-negative integer" };
    }
    return {
      fields: { requestId: raw.requestId, cursorSeq: raw.cursorSeq },
    };
  },
  "foreign-dirty-resync.result": (raw) => {
    if (!isNonEmptyString(raw.requestId)) {
      return { detail: "requestId must be a non-empty string" };
    }
    // 0 is legitimate: nothing was missed during the outage.
    if (!isNonNegativeSafeInteger(raw.throughSeq)) {
      return { detail: "throughSeq must be a non-negative integer" };
    }
    const readers = readReaderIdentities(raw.readers);
    if ("detail" in readers) return readers;
    return {
      fields: {
        requestId: raw.requestId,
        readers: readers.readers,
        throughSeq: raw.throughSeq,
      },
    };
  },
};

const readMessageRecord = (
  raw: Record<string, unknown>,
): CrossSpaceParseResult => {
  if (!isPositiveSafeInteger(raw.v)) {
    return {
      ok: false,
      error: "malformed-envelope",
      detail: "v must be a positive integer",
    };
  }
  if (raw.v !== CROSS_SPACE_PROTOCOL_VERSION) {
    return {
      ok: false,
      error: "unsupported-version",
      detail: `cross-space protocol version ${raw.v} is not ` +
        `${CROSS_SPACE_PROTOCOL_VERSION} — cross-version coexistence is a ` +
        "link-negotiation concern (C3.10a)",
      v: raw.v,
      ...(typeof raw.type === "string" ? { type: raw.type } : {}),
    };
  }
  if (!isNonEmptyString(raw.linkId)) {
    return {
      ok: false,
      error: "malformed-envelope",
      detail: "linkId must be a non-empty string",
    };
  }
  if (!isNonEmptyString(raw.fromSpace) || !isNonEmptyString(raw.toSpace)) {
    return {
      ok: false,
      error: "malformed-envelope",
      detail: "fromSpace and toSpace must be non-empty strings",
    };
  }
  if (raw.fromSpace === raw.toSpace) {
    return {
      ok: false,
      error: "malformed-envelope",
      detail: "fromSpace must differ from toSpace — a space never speaks " +
        "the cross-space protocol to itself",
    };
  }
  if (!isNonEmptyString(raw.type)) {
    return {
      ok: false,
      error: "malformed-envelope",
      detail: "type must be a non-empty string",
    };
  }
  const reader = (PAYLOAD_READERS as Record<string, PayloadReader>)[raw.type];
  if (reader === undefined) {
    return {
      ok: false,
      error: "unknown-type",
      detail: `unknown cross-space message type "${raw.type}" (additive ` +
        "evolution: dispatch policy is the endpoint's)",
      type: raw.type,
      v: raw.v,
    };
  }
  const payload = reader(raw);
  if ("detail" in payload) {
    return {
      ok: false,
      error: "malformed-message",
      detail: `${raw.type}: ${payload.detail}`,
      type: raw.type,
      v: raw.v,
    };
  }
  const message = deepFreeze({
    v: raw.v,
    linkId: raw.linkId,
    fromSpace: raw.fromSpace,
    toSpace: raw.toSpace,
    type: raw.type,
    ...payload.fields,
  }) as unknown as CrossSpaceMessage;
  return { ok: true, message };
};

/**
 * Parse one wire frame. Additive-tolerant read: unknown fields on known
 * types are dropped, unknown types and non-current versions return
 * distinguishable non-throwing outcomes. The returned message is deeply
 * frozen and carries EXACTLY the known field set.
 */
export const parseCrossSpaceMessage = (
  wire: string,
): CrossSpaceParseResult => {
  let raw: unknown;
  try {
    raw = JSON.parse(wire);
  } catch (error) {
    return {
      ok: false,
      error: "malformed-json",
      detail: `frame is not JSON: ${error}`,
    };
  }
  if (!isRecord(raw)) {
    return {
      ok: false,
      error: "malformed-envelope",
      detail: "frame must be a JSON object",
    };
  }
  return readMessageRecord(raw);
};

/**
 * Strict write: validates through the same per-type reader the parser
 * uses (so anything encoded is parseable by construction — throws
 * {@link CrossSpaceProtocolError} `malformed-message` at the SEND site
 * on a bad value) and emits exactly the known field set.
 */
export const encodeCrossSpaceMessage = (
  message: CrossSpaceMessage,
): string => {
  const read = readMessageRecord(
    message as unknown as Record<string, unknown>,
  );
  if (!read.ok) {
    throw new CrossSpaceProtocolError(
      "malformed-message",
      `refusing to encode a malformed cross-space message ` +
        `(${read.error}): ${read.detail}`,
    );
  }
  return JSON.stringify(read.message);
};

/**
 * Ordering guarantees a transport declares. `perLinkFifo` is the floor
 * (always true — declared so harnesses can assert the contract exists);
 * `receiveOrderFencing` and `linkTopology` are the C3A7 slot — see the
 * module docblock. C3.8 records the arm ruling; C3.10b states the
 * co-hosted transport's ordering through this same declaration.
 */
export interface CrossSpaceOrderingCapability {
  /** Messages on one link are delivered in send order. The floor. */
  perLinkFifo: true;
  /**
   * Whether delivery order on a link is a receive order strong enough
   * for C3A7's receive-order fence arm: emissions of the peer host
   * arrive in that host's commit order relative to every other message
   * on the link (bumps cannot overtake earlier notices/results).
   */
  receiveOrderFencing: boolean;
  /**
   * "single-multiplexed-per-host-pair": all cross-space messages between
   * two hosts ride exactly one ordered link (what the receive-order arm
   * requires). "per-space-pair": each space pair may ride its own link
   * (per-link FIFO only across that pair).
   */
  linkTopology: "single-multiplexed-per-host-pair" | "per-space-pair";
}

export type CrossSpaceLinkState = "open" | "closed";

/**
 * Link lifecycle (C3A12): `reconnected` fires with the bumped
 * incarnation on re-establishment; durable per-link state (the dirt
 * cursor, subscriptions, epoch resync) is keyed by the stable `linkId`
 * and state belonging to dead incarnations is dropped by incarnation
 * compare. The in-process link never fires `reconnected`.
 */
export type CrossSpaceLinkLifecycleEvent =
  | { kind: "open"; incarnation: number }
  | { kind: "reconnected"; incarnation: number }
  | { kind: "closed" };

/**
 * The ordered frame channel between this host and one peer host. Frames
 * are encoded wire messages ({@link encodeCrossSpaceMessage}); the
 * channel itself never interprets them. Per-link FIFO: `onMessage`
 * handlers observe frames in send order; the channel does not await
 * handler completion (application-level barriers — the C3A10 ack — are
 * the consumer's).
 */
export interface CrossSpaceChannel {
  /** Stable link identity — durable per-link state is keyed by this. */
  readonly linkId: string;
  /** Monotonic incarnation; bumps on each reconnect (C3A12). */
  readonly incarnation: number;
  readonly state: CrossSpaceLinkState;
  send(wire: string): void;
  onMessage(handler: (wire: string) => void): () => void;
  onLifecycle(
    handler: (event: CrossSpaceLinkLifecycleEvent) => void,
  ): () => void;
  close(): void;
}

/**
 * C3.10a (2026-07-18) — the routing-table face a multi-host transport
 * exposes. This is the seam the C3.1 transport docblock reserved for
 * C3.10a ("the space→host routing and the accept-side surfacing of
 * channels a remote peer dialed"): a transport that maintains real
 * links to peer hosts declares it, and the two host-side consumers
 * wire through it —
 *
 * - the {@link CrossSpaceHostRouter} consumes `onChannel` (so frames a
 *   peer sends are dispatched even when this host never initiated a
 *   send) and notifies `spaceRegistered` (so the transport's hello /
 *   hosted-spaces declaration tracks the local hosted set);
 * - the `Server` consults `peerHostFor` (the openEngine gate: a space
 *   routed to a peer is NEVER locally materialized — C3A1), enumerates
 *   `routedSpaces` (the C3.2 bump fan-out's link-peer set), and
 *   eagerly registers `configuredLocalSpaces` (deployment-declared
 *   hosting, so a configured space's inbox exists before first serve).
 *
 * The in-process transport carries no routing face (`routing` absent):
 * one host, no peers, nothing to route — all consumers are
 * `?.`-guarded, so single-host behavior is byte-identical.
 */
export interface CrossSpaceTransportRouting {
  /** Peer hostId the routing table routes `space` to; undefined when
   * `space` is not peer-routed (locally hosted or unknown). */
  peerHostFor(space: string): string | undefined;
  /** Every space currently routed to some peer over a live link. */
  routedSpaces(): readonly string[];
  /** Deployment-configured locally-hosted spaces (may be empty; the
   * dynamic arm is `spaceRegistered`). */
  configuredLocalSpaces(): readonly string[];
  /**
   * Accept-side channel surfacing: `handler` fires for every link
   * channel that reaches the open state — including ones already open
   * at subscribe time (replayed synchronously), so router and link
   * construction order is free. Returns an unsubscribe.
   */
  onChannel(handler: (channel: CrossSpaceChannel) => void): () => void;
  /** Router → transport: `space` registered as hosted on this host
   * (drives the link hello / hosted-spaces update declarations). */
  spaceRegistered(space: string): void;
}

/**
 * A transport provides ordered channels to peer hosts and declares its
 * ordering capability. `channelTo` is the send-side resolution seam:
 * the space→host routing (and the accept-side surfacing of channels a
 * remote peer dialed) is C3.10a's — carried by the optional
 * {@link CrossSpaceTransportRouting} face; in-process the one loopback
 * channel is both the send and the receive seam and `routing` is
 * absent.
 */
export interface CrossSpaceTransport {
  readonly kind: string;
  readonly ordering: CrossSpaceOrderingCapability;
  /** The channel carrying messages to the host of the given space. */
  channelTo(space: string): CrossSpaceChannel;
  /** C3.10a: the routing-table face of a multi-host transport. */
  readonly routing?: CrossSpaceTransportRouting;
  close(): void;
}

/**
 * Delivery context the router hands an inbound handler alongside the
 * parsed message (already validated: `space === message.toSpace`,
 * `fromSpace === message.fromSpace`, `linkId` is the channel the frame
 * actually arrived on).
 */
export interface CrossSpaceDeliveryContext {
  readonly space: string;
  readonly fromSpace: string;
  readonly linkId: string;
  readonly incarnation: number;
}

export type CrossSpaceInboundHandler = (
  message: CrossSpaceMessage,
  context: CrossSpaceDeliveryContext,
) => void;

/** Handle for one hosted-space registration on the router. */
export interface CrossSpaceRegistration {
  readonly space: string;
  close(): void;
}

/**
 * One directed send handle: `localSpace`'s side of the link toward
 * `remoteSpace`'s host. The endpoint stamps every envelope field itself
 * ({@link CrossSpaceMessageInit}); a malformed body throws at `send`.
 */
export interface CrossSpaceLinkEndpoint {
  readonly localSpace: string;
  readonly remoteSpace: string;
  readonly linkId: string;
  readonly incarnation: number;
  readonly state: CrossSpaceLinkState;
  send(init: CrossSpaceMessageInit): void;
  onLifecycle(
    handler: (event: CrossSpaceLinkLifecycleEvent) => void,
  ): () => void;
}

/**
 * The in-process transport: the protocol's first transport (context-
 * lattice §5) — one loopback channel inside one `Server` process, so the
 * "two endpoints" of any link are two per-space registrations on the
 * same host router. Every frame still round-trips the codec
 * (encode-at-send, parse-at-dispatch), so anything exchanged in-process
 * is wire-expressible by construction — the property whose absence
 * created the C3A1 in-process accident.
 *
 * Ordering: one FIFO delivery queue carries ALL frames (the degenerate
 * single host pair), drained in microtask order — so it truthfully
 * declares `single-multiplexed-per-host-pair` with receive-order
 * fencing, satisfying either C3A7 arm.
 */
export class InProcessCrossSpaceTransport implements CrossSpaceTransport {
  readonly kind = "in-process";
  readonly ordering: CrossSpaceOrderingCapability = Object.freeze({
    perLinkFifo: true as const,
    receiveOrderFencing: true,
    linkTopology: "single-multiplexed-per-host-pair" as const,
  });
  #channel: InProcessCrossSpaceChannel;

  constructor(options: { linkId?: string } = {}) {
    this.#channel = new InProcessCrossSpaceChannel(
      options.linkId ?? `xsp:inproc:${crypto.randomUUID()}`,
    );
  }

  channelTo(_space: string): CrossSpaceChannel {
    return this.#channel;
  }

  close(): void {
    this.#channel.close();
  }
}

class InProcessCrossSpaceChannel implements CrossSpaceChannel {
  readonly linkId: string;
  readonly incarnation = 1;
  #state: CrossSpaceLinkState = "open";
  #queue: string[] = [];
  #drainScheduled = false;
  #messageHandlers = new Set<(wire: string) => void>();
  #lifecycleHandlers = new Set<
    (event: CrossSpaceLinkLifecycleEvent) => void
  >();

  constructor(linkId: string) {
    this.linkId = linkId;
  }

  get state(): CrossSpaceLinkState {
    return this.#state;
  }

  send(wire: string): void {
    if (this.#state !== "open") {
      throw new CrossSpaceProtocolError(
        "link-closed",
        `cross-space link ${this.linkId} is closed`,
      );
    }
    this.#queue.push(wire);
    if (!this.#drainScheduled) {
      this.#drainScheduled = true;
      queueMicrotask(() => this.#drain());
    }
  }

  #drain(): void {
    this.#drainScheduled = false;
    const batch = this.#queue;
    this.#queue = [];
    for (const wire of batch) {
      // Frames not yet delivered when the link closes are dropped — a
      // closed link carries no delivery guarantee (reconnect recovery is
      // the C3A12 cursor's job, owned by C3.1b/C3.10b).
      if (this.#state !== "open") return;
      for (const handler of [...this.#messageHandlers]) {
        try {
          handler(wire);
        } catch (error) {
          console.warn("cross-space channel handler failed", error);
        }
      }
    }
  }

  onMessage(handler: (wire: string) => void): () => void {
    this.#messageHandlers.add(handler);
    return () => {
      this.#messageHandlers.delete(handler);
    };
  }

  onLifecycle(
    handler: (event: CrossSpaceLinkLifecycleEvent) => void,
  ): () => void {
    this.#lifecycleHandlers.add(handler);
    return () => {
      this.#lifecycleHandlers.delete(handler);
    };
  }

  close(): void {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#queue = [];
    for (const handler of [...this.#lifecycleHandlers]) {
      try {
        handler({ kind: "closed" });
      } catch (error) {
        console.warn("cross-space lifecycle handler failed", error);
      }
    }
  }
}

/**
 * The host-level cross-space router — the seam a `Server` owns (one per
 * host). Hosted spaces REGISTER here (the receive seam: each space's
 * inbox handler), senders obtain directed endpoints via {@link link},
 * and inbound frames dispatch on the envelope's `toSpace` uniformly.
 *
 * The hosted-space registry (`isHosted`/`hostedSpaces`) is where a
 * host's authoritative "which spaces live here" knowledge sits. C3.1b
 * (2026-07-18) wired it: the `Server` registers every space it serves
 * (each `openEngine` on the serve path registers the space's protocol
 * inbox here, and re-registers store-materialized spaces lazily after a
 * restart), its `openEngine` gate consults the registry (a peer-write
 * apply refuses to open an engine for a space not hosted here), and
 * `mirrorSchedulerObservation` / `propagateSchedulerDirtyToOwnerSpaces`
 * route through the transport — the handler on the registered inbox
 * performs the engine writes the direct calls used to.
 *
 * Send-side integrity: `link(fromSpace, …)` requires `fromSpace` to be
 * registered — a host only ever speaks for spaces it hosts (the
 * structural seed of C3A13's stamp binding; the routing-table half is
 * C3.10a's). Delivery to an unregistered `toSpace` is dropped with a
 * warning and NO side effects — the router never opens an engine or
 * creates state for an unhosted space. C3.1b ruled AGAINST a negative-
 * ack message for that drop (see the module docblock).
 */
export class CrossSpaceHostRouter {
  #transport: CrossSpaceTransport;
  #registrations = new Map<string, CrossSpaceInboundHandler>();
  #channels = new Map<string, { channel: CrossSpaceChannel }>();
  #closed = false;
  #detachRoutingChannels: (() => void) | undefined;

  constructor(transport: CrossSpaceTransport) {
    this.#transport = transport;
    // C3.10a accept side: subscribe dispatch to every link channel the
    // transport surfaces (a peer may speak first — this host must hear
    // frames on links it never sent on). In-process: no routing face,
    // the loopback attaches on first `link()` as before.
    this.#detachRoutingChannels = transport.routing?.onChannel(
      (channel) => this.#attachChannel(channel),
    );
  }

  get transport(): CrossSpaceTransport {
    return this.#transport;
  }

  get ordering(): CrossSpaceOrderingCapability {
    return this.#transport.ordering;
  }

  register(
    space: string,
    handler: CrossSpaceInboundHandler,
  ): CrossSpaceRegistration {
    this.#assertOpen();
    if (this.#registrations.has(space)) {
      throw new CrossSpaceProtocolError(
        "space-already-registered",
        `space ${space} is already registered on this host router`,
      );
    }
    this.#registrations.set(space, handler);
    // C3.10a: the transport's routing table tracks the local hosted set
    // (hello / hosted-spaces update declarations). Failure is contained:
    // a declaration hiccup must never turn a local registration into a
    // registration failure.
    try {
      this.#transport.routing?.spaceRegistered(space);
    } catch (error) {
      console.warn(
        "cross-space transport spaceRegistered notification failed",
        error,
      );
    }
    return {
      space,
      close: () => {
        if (this.#registrations.get(space) === handler) {
          this.#registrations.delete(space);
        }
      },
    };
  }

  isHosted(space: string): boolean {
    return this.#registrations.has(space);
  }

  hostedSpaces(): readonly string[] {
    return [...this.#registrations.keys()];
  }

  link(fromSpace: string, toSpace: string): CrossSpaceLinkEndpoint {
    this.#assertOpen();
    if (fromSpace === toSpace) {
      throw new CrossSpaceProtocolError(
        "self-link",
        "a space never speaks the cross-space protocol to itself",
      );
    }
    if (!this.#registrations.has(fromSpace)) {
      throw new CrossSpaceProtocolError(
        "space-not-hosted",
        `cannot speak for ${fromSpace}: not registered on this host ` +
          "router (a host only stamps spaces it hosts — C3A13)",
      );
    }
    const channel = this.#ensureChannel(toSpace);
    return {
      localSpace: fromSpace,
      remoteSpace: toSpace,
      linkId: channel.linkId,
      get incarnation() {
        return channel.incarnation;
      },
      get state() {
        return channel.state;
      },
      send: (init: CrossSpaceMessageInit) => {
        // Envelope stamps come AFTER the init spread so a caller can
        // neither mis-version nor misroute a message even by handing an
        // object that (unsoundly) carries envelope fields.
        const message = {
          ...init,
          v: CROSS_SPACE_PROTOCOL_VERSION,
          linkId: channel.linkId,
          fromSpace,
          toSpace,
        } as CrossSpaceMessage;
        // encode validates — a malformed body fails loudly at the send
        // site, never on the peer.
        channel.send(encodeCrossSpaceMessage(message));
      },
      onLifecycle: (handler) => channel.onLifecycle(handler),
    };
  }

  #ensureChannel(space: string): CrossSpaceChannel {
    const channel = this.#transport.channelTo(space);
    this.#attachChannel(channel);
    return channel;
  }

  #attachChannel(channel: CrossSpaceChannel): void {
    if (this.#closed) return;
    if (!this.#channels.has(channel.linkId)) {
      this.#channels.set(channel.linkId, { channel });
      channel.onMessage((wire) => this.#dispatch(channel, wire));
    }
  }

  #dispatch(channel: CrossSpaceChannel, wire: string): void {
    const parsed = parseCrossSpaceMessage(wire);
    if (!parsed.ok) {
      console.warn(
        `cross-space router dropped an undeliverable frame ` +
          `(${parsed.error}): ${parsed.detail}`,
      );
      return;
    }
    const message = parsed.message;
    if (message.linkId !== channel.linkId) {
      console.warn(
        `cross-space router dropped a frame stamped for link ` +
          `${message.linkId} arriving on ${channel.linkId}`,
      );
      return;
    }
    const handler = this.#registrations.get(message.toSpace);
    if (handler === undefined) {
      console.warn(
        `cross-space router dropped a ${message.type} for unhosted ` +
          `space ${message.toSpace}`,
      );
      return;
    }
    try {
      handler(
        message,
        Object.freeze({
          space: message.toSpace,
          fromSpace: message.fromSpace,
          linkId: channel.linkId,
          incarnation: channel.incarnation,
        }),
      );
    } catch (error) {
      console.warn("cross-space inbound handler failed", error);
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new CrossSpaceProtocolError(
        "router-closed",
        "cross-space host router is closed",
      );
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#detachRoutingChannels?.();
    this.#registrations.clear();
    this.#channels.clear();
    this.#transport.close();
  }
}
