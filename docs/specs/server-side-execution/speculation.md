# v2 detail: client speculation

Normative spec for Phase 2 (overlay + authored writes) and the client
half of Phase 3. Assumes [README.md](README.md) §3.2 and
[events.md](events.md).

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- The client runtime already runs the full graph; v2 does not add a
  speculation engine — it REDIRECTS the existing run's writes into an
  overlay instead of a storage transaction.
- Overlay substrate: the storage stack's transaction/journal layering in
  `packages/runner/src/storage/` (`extended-storage-transaction.ts`,
  `cache.ts`). The v1 branch validated "drop authority, keep the run"
  against this stack; the concept ports, the code does not.

## 1. The overlay, defined

- A client-side value layer keyed by (doc, path) sitting above the
  replicated store. Reads check overlay first, then store.
- Every entry records: `baseSeq` (the space seq the speculation ran
  against) and `origin` — either `intent(eventId)` (a locally fired,
  not-yet-consequenced event) or `input(bindingId)` (live UI input echo).
- The overlay is process-memory only. It is NEVER serialized, synced, or
  committed. On reload it is empty and the store is the truth.

## 2. What may speculate

- The membership test is the SCHEDULER TELL (RULED, owner 2026-08-07;
  protocol.md §1 carries the primary statement and the owner's
  rationale): ONLY scheduler-driven work moves to the server —
  scheduler-stamped derivation and handler runs are what divert here.
  Commits OUTSIDE the scheduler — setup/instantiation transactions,
  imperative creation (with its sanctioned `.pull`-for-round-one
  flow), UI bindings, widget edits — are the client's authored acts
  and commit as today. NO creation carve-out: a pattern instantiated
  within a lift/map/filter is a derived computation like any other,
  so its first run diverts even at instantiation.
- Pure structural nodes: freely.
- Handlers: run locally on fire, writes go to the overlay (events.md §2);
  the committed artifact is the event only.
- Effectful nodes (`fetch*`, `generate*`, `sqlite*`): NEVER execute
  client-side. A speculative read of such a node returns its last
  committed result (read-through). If inputs changed so the memo key
  differs, the node reads as pending — the UI shows its ordinary loading
  state until the server's result arrives. No exceptions: no "just this
  one idempotent GET".
- `navigate-to`: may enact optimistically (protocol.md §5) — navigation
  is reversible. The overlay records the nonce it acted on.
- Child-piece instantiation (builtins.md §3): result-as-pattern
  children MAY instantiate speculatively, overlay-local (owner,
  2026-08-02 — reversing the earlier no-children rule). Child ids
  derive from cause, so the speculative child converges with the
  authoritative one by identity when the push arrives; overlay
  containment applies — the child's registrations and writes are
  overlay-side, nothing commits, and they retire with their origin
  entry on reconcile (§4). `compile-and-run` children are NOT
  speculable (compilation is an effectful step): that branch renders
  its ordinary loading state until the authoritative push delivers
  the child (runtime-mapping.md N37/N38).
- **Unreplicated inputs**: a speculative read of a doc/path the client
  has not replicated is PENDING for that branch — speculation NEVER
  blocks on a fetch and never triggers a network read. The branch
  renders its ordinary loading state and reconciles when the server's
  derived value arrives. (The server discovers the same read by running
  with the store local — serving-loop.md §3b; the asymmetry is the
  point.)

## 3. Rendering

Rendering reads through the overlay, so the actor sees handler
consequences immediately (echo) and everyone's UI reads identically
through one code path. There is no "speculative styling" requirement in
v2; divergence handling is value replacement (§4), not UI annotation
(RULED 2026-08-02: replacement IS the reconciliation UX — how
conflicts render today; no divergence surfacing ships in v2).

## 4. Reconciliation, exactly

On each pushed `derived` commit with `derivedThrough = W` and
`consequenceOf = [E...]`:

1. Apply the commit to the local store replica (existing path).
2. Retire overlay entries whose `origin` is `intent(e)` for `e ∈ E` —
   the authoritative consequences (or, for a dropped event, its
   notice — events.md §5) now exist; the echo's job is done.
3. Retire overlay entries whose `origin` is `input` once their authored
   commit is acked AND `W ≥` that commit's seq — regardless of value
   agreement (the store wins); keep live-input echoes whose authored
   commit is still unacked or not yet covered by `W` (the user is
   mid-typing).
4. If any local intents remain un-consequenced (offline queue, in-flight
   events), re-run their speculation against the fresh store state so
   the echo rebases instead of going stale.

Divergence is silent by default: the authoritative value replaces the
speculative one in the same render path — the simplest thing, and
exactly how conflicts render today (RULED 2026-08-02). No flicker
suppression beyond what rebasing gives.

Stated honestly (RULED 2026-08-07; owed from the wedge round): the
overlay retires on watermark coverage of its BASIS, not on value
ARRIVAL — "the store wins" carries no by-construction guarantee that
the store HOLDS what won at withdrawal time (W covers DEMANDED
derivations; nothing about an entry's own output riding the covering
wave is implied). What makes retirement safe is the serving loop's
first-round reliability machinery — the demanded-structure loads with
their counted, retried deferrals (serving-loop.md §1/§3's demand
cycle and its ensure-retry) — which makes the demanded derivation
exist and land.

## 5. Offline

- Events accumulate locally in fired order (events.md §5), speculation
  stands, the overlay grows. On reconnect: discharge queued events in
  order, then reconcile as pushes arrive (RULED 2026-08-02). A
  discharged event whose handler conflicts is DROPPED server-side;
  its dropped-event notice (eventId + reason, events.md §5) retires
  the event's overlay entries — the echo un-renders instead of
  lingering as false state — and is the UI's hook to react (the UI
  treatment is a follow-up; components that send authored commits
  already handle conflict feedback gracefully today, and events
  reuse that posture). Overlay memory is bounded by pending-intent
  count.

## 6. Tripwires

FORBIDDEN client-side under the flag: constructing a `derived`-class
commit; committing any handler write; executing an effectful builtin;
persisting the overlay; sending overlay contents to any server; deciding
"the server is wrong" (there is no client arbitration — the store wins,
always, by construction).
