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

## 3. Rendering

Rendering reads through the overlay, so the actor sees handler
consequences immediately (echo) and everyone's UI reads identically
through one code path. There is no "speculative styling" requirement in
v2; divergence handling is value replacement (§4), not UI annotation.
(Q5 in README §6 tracks whether product wants divergence surfaced.)

## 4. Reconciliation, exactly

On each pushed `derived` commit with `derivedThrough = W` and
`consequenceOf = [E...]`:

1. Apply the commit to the local store replica (existing path).
2. Retire overlay entries whose `origin` is `intent(e)` for `e ∈ E` —
   the authoritative consequences now exist; the echo's job is done.
3. Retire overlay entries with `baseSeq < W` whose `origin` is `input` if
   the store now agrees with them; keep live-input echoes that are ahead
   of the store (the user is mid-typing).
4. If any local intents remain un-consequenced (offline queue, in-flight
   events), re-run their speculation against the fresh store state so
   the echo rebases instead of going stale.

Divergence is silent by default: the authoritative value replaces the
speculative one in the same render path. No flicker suppression beyond
what rebasing gives — measure first (Q5), design after.

## 5. Offline

- Events queue locally in fired order (events.md §5), speculation stands,
  the overlay grows. On reconnect: submit queued events in order, then
  reconcile as pushes arrive. Overlay memory is bounded by pending-intent
  count — if product wants long-offline, that is a Q1 design pass, not an
  incremental tweak here.

## 6. Tripwires

FORBIDDEN client-side under the flag: constructing a `derived`-class
commit; committing any handler write; executing an effectful builtin;
persisting the overlay; sending overlay contents to any server; deciding
"the server is wrong" (there is no client arbitration — the store wins,
always, by construction).
