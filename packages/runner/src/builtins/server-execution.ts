import type { NormalizedFullLink } from "../link-utils.ts";

/**
 * Builtins whose external work has a server-side implementation in the first
 * server-primary rollout. Keep this list deliberately exact: a raw module only
 * receives this identity when it was resolved through the canonical builtin
 * registry ref, never from caller-controlled debug metadata.
 *
 * "Server-side implementation" is NOT a synonym for "has a broker fetch route".
 * Every member up to `llmDialog` dials `runtime.fetchBuiltin`, and that made the
 * two read as the same thing; `navigateTo` is the first member whose server-side
 * work is a MESSAGE rather than an egress (see its entry below). What membership
 * actually buys is uniform: the `:server-v1` implementation fingerprint, which
 * is the only key `supportedBuiltinDescriptor`
 * (`executor/action-transaction-router.ts`) accepts, and therefore the only way
 * an EFFECT node ever acquires an assembled scope summary instead of
 * classifying `unknown-effect-surface`.
 *
 * `streamData` is the R5 effect row REFUSED (2026-07-30), and the refusal is
 * about EGRESS, not about surface: its three minted documents
 * (`pending`/`result`/`error`) are the same shape `fetch.ts` already declares
 * through `serverBuiltinRuntimeWrites`, so a descriptor would assemble
 * perfectly well. Two independent blockers sit in front of that.
 *
 *  1. It egresses by calling `globalThis.fetch` directly with the authored url
 *     (`stream-data.ts`), never `runtime.fetchBuiltin`. The executor Worker's
 *     `fetch: denyExternalBuiltinFetch` is a RUNTIME option
 *     (`executor-worker.ts`), so it never sees that call — the same bypass
 *     `wish` has, but pointed at an AUTHOR-SUPPLIED url instead of `wish`'s
 *     fixed `patternUrl()` on our own API. The owner ruling that accepted
 *     `wish`'s bypass turned on that fixed destination; it does not extend
 *     here. Membership would put unbrokered, unauthorized, DNS-unpinned egress
 *     to an arbitrary host on the serving box, which is precisely what
 *     `createDefaultServerBuiltinBroker`'s `fetchExternalPinned` path exists
 *     to prevent.
 *  2. It cannot simply be rewired to the broker, because the broker is a
 *     BOUNDED, BUFFERED request/response and that is a deliberate invariant,
 *     not an unfinished edge. `server-builtin-egress.ts`'s defaults —
 *     `timeoutMs: 30_000`, `maxResponseBytes: 8 MiB`, and a docblock that says
 *     in as many words that external I/O has no guaranteed completion event,
 *     so it is bounded "so a claimed builtin cannot hold its action/lease
 *     forever" and a timeout "follows the normal transient-failure path rather
 *     than accepting a partial response". The channel then materializes the
 *     whole body twice more (`new Uint8Array(await
 *     result.response.arrayBuffer())` host-side,
 *     `new Response(response.body.slice(), …)` Worker-side, in
 *     `executor/server-builtin-channel.ts`).
 *
 *     `streamData`'s contract is the exact negation of all three: an
 *     unbounded-duration connection, consumed incrementally through
 *     `response.body.getReader()`, publishing each SSE frame as it arrives.
 *     "Partial response" is its entire output. On a stream that stays open the
 *     bounded read never completes and the builtin gets a 30 s transient
 *     failure instead of data.
 *
 * Its lifetime compounds both: the loop is unbounded and, unlike `fetch.ts`,
 * never `runtime.trackAsyncWork`ed, so neither `settled()` nor the executor's
 * activation fixpoint can observe it — the very hazard the broker's timeout
 * exists to prevent, arriving by a route the broker does not police. Serving
 * `streamData` means designing a STREAMING broker seam and a run-scoped
 * lifetime for it, and deciding what a claim means when the effect outlives
 * every run; it is not an allowlist edit. (Its kind is already correct —
 * CP6's flip to `isEffect: true` landed and is pinned by
 * `builtin-effect-registry.test.ts`; kind was never what kept it out.)
 */
export const SERVER_EXECUTABLE_BUILTIN_IDS = [
  "fetchBinary",
  "fetchText",
  "fetchJson",
  "fetchJsonUnchecked",
  "fetchProgram",
  // The three LLM builtins share one broker route: `executeWithToolsLoop` →
  // `llmClientOptions` → `runtime.fetchBuiltin(<id>, "/api/ai/llm", …)`. Each
  // passes its own id so the host egress classifier and the per-builtin
  // channel keep them distinct.
  "llm",
  "generateText",
  "generateObject",
  // `llmDialog` dials the same `/api/ai/llm` broker route, through the same
  // `llmClientOptions`. Its trigger is what makes it server-executable at all:
  // the dialog turn starts from DOCUMENT state (`result.pending` plus
  // `internal.requestId`), not from the `addMessage` handler's process, so the
  // peer that appends a user message need not be the peer that egresses —
  // which is exactly what "handlers stay client-side, the dialog runs
  // server-side" requires.
  "llmDialog",
  // `navigateTo` joins for the SEAM, not for a broker route (owner gate 2,
  // `docs/specs/server-side-execution/navigate-to-server-side.md` §2c: it is
  // not a pattern effect OR a rendering effect but BOTH, split at a seam — the
  // DECISION to navigate derives from pattern state and belongs server-side;
  // the ACTUATION is a shell view change and stays a client rendering effect,
  // and the server→client message IS the seam).
  //
  // It dials no `/api/...` route at all, so its `runtime.fetchBuiltin` channel
  // is never opened. Membership is load-bearing for one thing only: the
  // `:server-v1` fingerprint that lets the generically-minted
  // `ServerBuiltinActionDescriptor` be honored, without which the node
  // classifies `unknown-effect-surface` forever and no lane can ever claim it.
  //
  // Its write surface is why the effect route is the only one available: the
  // SESSION-scoped result instance it mints (`navigate-to.ts`,
  // `createCell(..., scope: "session")`) is not a registered output cell, so it
  // rides `serverBuiltinRuntimeWrites` — a field the computation descriptor has
  // no equivalent of. The same declaration is the design's safety hinge: a
  // `session`-declared write is admitted ONLY at session lane rank
  // (`scheduler/servability.ts` `laneAdmitsScope`), which is what makes a
  // space-rank navigate claim — the one shape whose delivery has no principal
  // filter, and would therefore drag every co-tenant of a shared space —
  // structurally unreachable rather than merely unintended. Pinned by
  // `test/navigate-to-rank-containment.test.ts`; drop the declaration and that
  // file goes red.
  "navigateTo",
  // `sqliteQuery` joins as the SECOND non-fetch member, and for a different
  // reason than `navigateTo`: its server-side work is a server-side read that
  // the executor was already able to perform. The Worker's storage manager is
  // a `HostStorageManager`, whose provider forwards `sqliteQuery` over the
  // memory port to the same `sqlite.query` verb the client uses
  // (`storage/v2-host-provider.ts`), so no broker route was ever the missing
  // piece — a second egress broker would have duplicated a working transport.
  // The registry test used to say "nothing server-side runs it at all yet";
  // that was the gap, and it is closed.
  //
  // Its write surface is a single minted document — the `QueryState`
  // `{ pending, result, error, requestHash, withheld }` cell `makeResultCell`
  // allocates — plus the output spot linking to it. The mint is not a
  // registered output cell (its scope is discovered per transaction: the
  // narrowest of the output binding, the db handle's scope, and the `user`
  // floor a read-clearance query forces), so it rides
  // `serverBuiltinRuntimeWrites`, which also carries the `["result"]` /
  // `["pattern"]` provenance meta the effect summary renders at document root.
  // The per-row entity documents a CFC-labeled result splits off carry
  // content-derived ids and cannot be declared; they ride
  // `sameTransactionMaterializedDocuments`, exactly like `llmDialog`'s
  // per-message documents.
  //
  // Two preconditions were load-bearing and both landed before this entry.
  // (1) Double-execution: `sqliteQuery` consults `externalSinkDisposition()`
  // BEFORE writing its `requestHash` dedup marker (8cb00bbf8) — write the
  // marker on the suppressed side and the result stays `pending` forever while
  // the issuing side is wedged. (2) Identity: the query RPC runs in a
  // post-commit flush, after `runWithExecutionLane` has restored the ambient
  // lane, so the builtin captures the acting lane synchronously in its action
  // body and carries it into the flush as `actingContext` (A5/G1, 57dd8da7f).
  // Without that a lease-bound executor serving alice's lane would open the
  // EXECUTOR principal's cell-db — a cell-db is a FILE, the scope context is
  // its selector, and no downstream per-address check catches a wrong
  // resolution. The same capture feeds `resolveCeilingPlaceholders` and the
  // read-clearance reader, which have the identical hazard.
  //
  // NOT covered, and still fails closed: `db.exec` writes. They fold a
  // `sqlite` op into an arbitrary CALLER's commit, which the routing layer
  // rejects unconditionally (`dynamic-sqlite-operation`, CP21/D2) — a
  // different action's transaction, not this node's.
  "sqliteQuery",
] as const;

export type ServerExecutableBuiltinId =
  typeof SERVER_EXECUTABLE_BUILTIN_IDS[number];

const SERVER_EXECUTABLE_BUILTIN_SET = new Set<string>(
  SERVER_EXECUTABLE_BUILTIN_IDS,
);

export function isServerExecutableBuiltinId(
  value: unknown,
): value is ServerExecutableBuiltinId {
  return typeof value === "string" &&
    SERVER_EXECUTABLE_BUILTIN_SET.has(value);
}

export function serverBuiltinImplementationHash(
  id: ServerExecutableBuiltinId,
): string {
  return `cf:builtin/${id}:server-v1`;
}

/**
 * Static implementation identity for a canonical builtin resolved through the
 * registry ref. Raw builtins are host functions with no SES provenance, so
 * `applyImplementationHash` cannot stamp them; without this their fingerprint
 * falls to an `action:…` shape that servability rejects as
 * `untrusted-implementation`. The `:v1` shape is deliberately distinct from
 * `serverBuiltinImplementationHash`'s `:server-v1`: identity ("this action IS
 * canonical builtin <id>") must never be conflated with "the server has a
 * native implementation of this external effect" — run.ts keys its
 * server-builtin effect-descriptor path on the exact `:server-v1` fingerprint.
 * The caller supplies the id ONLY from the canonical registry ref, never from
 * caller-controlled debug metadata.
 */
export function builtinImplementationHash(id: string): string {
  return `cf:builtin/${id}:v1`;
}

/** Runner-authored static portion of a supported builtin's action surface. */
export interface ServerBuiltinActionDescriptor {
  readonly version: 1;
  readonly id: ServerExecutableBuiltinId;
  readonly piece: NormalizedFullLink;
  readonly reads: readonly NormalizedFullLink[];
  readonly writes: readonly NormalizedFullLink[];
  /** Stable array populated by the builtin when it mints internal cells. */
  readonly runtimeWrites: readonly NormalizedFullLink[];
  readonly directOutputs: readonly NormalizedFullLink[];
}

/**
 * Builtins whose whole action surface is a single direct root output over their
 * registered inputs (W2.15a): each reads its inputs and writes exactly the one
 * minted result document plus the output spot that links to it. Verified
 * against `if-else.ts`, `when.ts`, `unless.ts` (each `setRawUntyped`s the single
 * result and nothing else) and `inspect-conf-label.ts` (mints
 * `{ inspectConfLabel: cause }` with a bare `runtime.getCell`, `sendResult`s a
 * link to it, `set`s the outcome into it; the metadata consultation
 * `inspectStoredConfLabel` only READS the target's `["cfc"]` subtree).
 *
 * `wish` joins them (R13, owner ruling 2026-07-29). Its measured surface IS
 * this shape: a resolving run writes exactly the minted
 * `{ wish: { state: cause } }` state document and the output spot linking to
 * it; a freeform run writes only the output spot. The reason it was refused a
 * descriptor before (a69aec5f9) was never the write surface — it was that
 * `wish` egresses UNBROKERED for its sidecar patterns, so certifying the
 * narrow surface would let both sides perform that egress. The owner ruled
 * that acceptable: the egress is an idempotent GET of a system pattern from
 * our own API (`patternUrl()` in `wish.ts`), so doubling it is harmless, and
 * D11 makes closing the serving gap the priority. What the descriptor does not
 * cover stays uncovered and fails closed: the sidecars' own transactions, the
 * mid-run `runtime.scheduler.subscribe`, and the user-scoped instance a
 * home-space target lands the state document at (admitted only under a scoped
 * lane, via the §4 `laneInstanceCovers` relaxation).
 *
 * Keep this registry deliberately exact, exactly like
 * `SERVER_EXECUTABLE_BUILTIN_IDS`: map/filter/flatMap carry output-collection
 * envelopes, so they are a separately-designed follow-up (W2.16) and must NOT
 * be added here. Membership is load-bearing beyond the descriptor: the runner
 * re-derives each member's minted result document through
 * `selectorBuiltinResultCause`, so an id added here whose builtin keys its mint
 * on a different cause gets a write surface naming a document it never writes —
 * and de-claims fail-closed on every run.
 *
 * The rest of the R5 worklist was audited against this shape and REJECTED:
 *  - `llmDialog` and `navigateTo` return `{ isEffect: true }` from their
 *    builtin factories, so the runner's `module.isEffect ?? builtinIsEffect`
 *    makes them EFFECT nodes whatever `index.ts` says. A computation
 *    descriptor cannot serve them —
 *    `serverBuiltinComputationScopeSummary` requires
 *    `actionKind === "computation"`, so the descriptor would never assemble.
 *    (`navigateTo` also enqueues a post-commit `navigateTo` effect through
 *    `runtime.navigateCallback`.) `llmDialog` took the EFFECT route instead
 *    and is now in `SERVER_EXECUTABLE_BUILTIN_IDS`: its four-document write
 *    surface — the three it mints (result / internal / pinnedCells) plus the
 *    `messages` transcript it appends model turns back into — rides
 *    `serverBuiltinRuntimeWrites`, which the computation descriptor has no
 *    field for. That asymmetry is the practical reason the effect route was
 *    the only one available, independent of the `actionKind` gate.
 *  - `compileAndRun` mints FOUR documents (`compile.pending|result|error|
 *    errors`) and writes from async `editWithRetry` transactions outside its
 *    own run.
 *
 *    The four-document count is PLUMBING, not a design gap: `mintedDocuments`
 *    below is already an array. What expresses only one is the mint site —
 *    `selectorBuiltinResultCause` returns a single cause and
 *    `selectorMintedResultWrite` (`runner.ts`) a single link — so serving this
 *    builtin means generalizing those two to a list, nothing deeper.
 *
 *    CORRECTED 2026-07-29: this entry used to call that surface "unbounded"
 *    because `runtime.runSynced` runs a whole compiled pattern under the
 *    result doc. MEASURED, it is not — the spawned pattern's writes are
 *    attributed to the SPAWNED pattern's own actions (own action id, own
 *    inner-module implementation fingerprint, own `pieceId`, own transformer
 *    certificate, classifying claim-ready), and none of them appears in
 *    `compileAndRun`'s observation. Its own surface is BOUNDED.
 *
 *    What actually blocks it is the async continuation, and the four-document
 *    mint points the same way `llmDialog` went. That blocker had two halves,
 *    and the ATTRIBUTION half is CLOSED as of 2026-07-29: `compileAndRun` now
 *    enqueues its compile and `runSynced` as a post-commit effect
 *    (`enqueuePostCommitEffect`, flushed inside
 *    `runWithTransactionSourceAction`) instead of firing
 *    `compileOrGetPattern(...).then(...)` inline, so its continuations inherit
 *    the run's `sourceAction` — the only path by which that context reaches an
 *    async continuation. Both forward routes needed that move, so it settles
 *    nothing about which one is taken.
 *
 *    The OBSERVATION half is still open, and it is what still blocks serving:
 *    continuation synthesis is EFFECT-ONLY. `supportedBuiltinDescriptor` in
 *    `executor/action-transaction-router.ts` requires a `serverBuiltin`
 *    descriptor AND `actionKind === "effect"`, so the summary/template a
 *    computation would need is never populated — every current member of this
 *    registry writes only inside its own synchronous body. Minting a
 *    computation descriptor for `compileAndRun` today would therefore still
 *    claim the in-run writes and strand the continuations in a local executor
 *    shadow, leaving `pending` true forever. Numbers in
 *    `compile-and-run-servability.test.ts`.
 *
 * `sqliteDatabase` JOINS them (R5, owner ruling 2026-07-29). Both of A3's
 * objections are closed. The db `owner` now comes from the acting execution
 * lane (`actingHandleOwner` in `sqlite-builtins.ts`), not the ambient
 * `trustSnapshotProvider()`, so a server-side first run no longer mints the
 * handle owned by the executor's lease principal. And its write surface IS this
 * shape: a mint writes exactly the handle document it allocates through
 * `makeResultCell` plus the output spot linking to it. What kept it out was the
 * PROVENANCE META paths `makeResultCell` stamps on that handle — a document-root
 * `["result"]` back-pointer (and `["pattern"]`, conditionally) beside the
 * `["value"]` payload — which a value-root envelope cannot cover, so every
 * minting run de-claimed `dynamic-write-outside-static-surface`. That is now
 * covered by the descriptor's `mintedDocuments` declaration (see below), not by
 * joining the materializer family: that route would also install
 * `materializerWriteEnvelopes`, which re-indexes the node in
 * `SchedulerMaterializers` and changes WHEN it is scheduled — a scheduling
 * change bought for an envelope fix. Measured end to end in
 * `sqlite-database-servability.test.ts`.
 */
export const SERVER_COMPUTATION_BUILTIN_IDS = [
  "ifElse",
  "when",
  "unless",
  "inspectConfLabel",
  "wish",
  "sqliteDatabase",
] as const;

export type ServerComputationBuiltinId =
  typeof SERVER_COMPUTATION_BUILTIN_IDS[number];

const SERVER_COMPUTATION_BUILTIN_SET = new Set<string>(
  SERVER_COMPUTATION_BUILTIN_IDS,
);

export function isServerComputationBuiltinId(
  value: unknown,
): value is ServerComputationBuiltinId {
  return typeof value === "string" &&
    SERVER_COMPUTATION_BUILTIN_SET.has(value);
}

/**
 * Runner-authored static surface for a pure selector builtin. Unlike the effect
 * descriptor, there are no `runtimeWrites`: the write surface is exactly the
 * single direct output, and the assembled summary is fail-closed (observed
 * runtime writes are never folded into the envelope).
 */
export interface ServerBuiltinComputationDescriptor {
  readonly version: 1;
  readonly id: ServerComputationBuiltinId;
  readonly piece: NormalizedFullLink;
  readonly reads: readonly NormalizedFullLink[];
  readonly writes: readonly NormalizedFullLink[];
  readonly directOutputs: readonly NormalizedFullLink[];
  /**
   * The side documents this node MINTS (a subset of `writes`, always value-root
   * links). Declaring one implicitly covers its PROVENANCE META paths —
   * `["result"]` and `["pattern"]`, and nothing else — beside the `["value"]`
   * payload the link itself renders (client-passivity §5h.2).
   *
   * Every mint that runs through `setResultCell`/`setPatternCell`
   * (`result-utils.ts`) stamps those two document-root siblings of `["value"]`:
   * `["result"]` unconditionally, `["pattern"]` only when the parent pattern
   * cell has a raw value. They are parent back-pointers production code walks
   * to resolve piece ownership (`ensure-piece-running.ts`, `piece/manager.ts`),
   * so they are not optional — but a value-root envelope can never cover them,
   * which de-claimed every minting run `dynamic-write-outside-static-surface`.
   *
   * Why this field rather than the MATERIALIZER summary's blanket value-root →
   * document-root lift (FB19/CA6): the lift would have to apply to the whole
   * declared surface, and this descriptor also declares the node's direct
   * OUTPUT SPOT at link path `[]` — bounding that whole document is far too
   * wide. Attaching the coverage to the minted document specifically keeps it
   * exact, and the minted document is wholly this node's own creation (its
   * identity is re-derived from the registration cause via
   * `selectorBuiltinResultCause`), so bounding its provenance meta is as tight
   * as bounding its value.
   *
   * Declaring a path the run does not write is harmless — the firewall bounds
   * WHICH addresses may be written, never what is written there — so a mint
   * that skips the conditional `["pattern"]` write still matches exactly. Only
   * the reverse de-claims. The SCOPE half needs nothing here: the §4
   * lane-instance relaxation (`servability.ts` `laneInstanceCovers` plus
   * `widenLaneOutputEnvelopes` in `executor/action-transaction-router.ts`)
   * already spans the whole declared write surface, so a mint allocated at a
   * scoped instance carries its provenance paths along.
   */
  readonly mintedDocuments: readonly NormalizedFullLink[];
}

/**
 * List builtins whose write surface is envelope-shaped: map/filter/flatMap each
 * mint a result CONTAINER document (the output collection) distinct from their
 * direct output and write the whole array plus per-slot element links into it
 * (W2.16). The per-element child sub-patterns are separate provenance-covered
 * actions, NOT this node's writes, so they are deliberately outside the
 * envelope — a first reconcile that instantiates children de-claims fail-closed
 * for that run and the client handles it, exactly like any other
 * dynamic-write-outside-static-surface. Keep this registry deliberately exact
 * (mirrors `SERVER_EXECUTABLE_BUILTIN_IDS`): only the three container-minting
 * list builtins belong; the pure selectors carry an exact single-output surface
 * (`SERVER_COMPUTATION_BUILTIN_IDS`) and `wish` is a resolver.
 */
export const SERVER_MATERIALIZER_BUILTIN_IDS = [
  "map",
  "filter",
  "flatMap",
] as const;

export type ServerMaterializerBuiltinId =
  typeof SERVER_MATERIALIZER_BUILTIN_IDS[number];

const SERVER_MATERIALIZER_BUILTIN_SET = new Set<string>(
  SERVER_MATERIALIZER_BUILTIN_IDS,
);

export function isServerMaterializerBuiltinId(
  value: unknown,
): value is ServerMaterializerBuiltinId {
  return typeof value === "string" &&
    SERVER_MATERIALIZER_BUILTIN_SET.has(value);
}

/**
 * Runner-authored static surface for a container-minting list builtin. Unlike
 * the pure selector descriptor, the write surface is an ENVELOPE
 * (`materializerWriteEnvelopes`, a root prefix over the result container) plus
 * the direct output — a checkable, fail-closed bound honest for a data-dependent
 * writer whose per-element slot count changes with the input list. The
 * envelope is re-derived from the resolved output cells each registration
 * (`instantiateRawNode`); the container identity is stable across list length,
 * so it never widens, but a run writing anywhere else de-claims at the firewall.
 */
export interface ServerBuiltinMaterializerDescriptor {
  readonly version: 1;
  readonly id: ServerMaterializerBuiltinId;
  readonly piece: NormalizedFullLink;
  readonly reads: readonly NormalizedFullLink[];
  readonly writes: readonly NormalizedFullLink[];
  readonly directOutputs: readonly NormalizedFullLink[];
  readonly materializerWriteEnvelopes: readonly NormalizedFullLink[];
}
