# v2 detail: protocol — commit classes, admission, push, watermark

Normative. Assumes [README.md](README.md); details Phases 1–4 surface
between client, memory server, and SpaceServer.

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

- Memory server: `packages/memory/v2.ts`, toolshed mount
  `/api/storage/memory` (`packages/toolshed/routes/storage/memory/`).
- Client storage stack: `packages/runner/src/storage/` (`interface.ts`,
  `extended-storage-transaction.ts`, `query.ts`, `reactivity-log.ts`).
- Store tables: `commit`, `revision`, `head`, `branch` (engine-v3).
  `execution_lease` does not exist on main — it is created in Phase 1
  (serving-loop.md §2; v1-branch shape as prior art).

## 1. Commit classes

Every commit carries a `class` in its metadata. Three values, closed set:

| class | producer | contents |
| --- | --- | --- |
| `authored` | any authorized session; server-produced only via delegated capability (§2) | doc writes (UI bindings, widget edits — and, until Phase 3 lands, client handler writes: the plan's stated interim posture) or event appends (events.md §1) |
| `derived` | the space's SpaceServer (lease holder) | derivation results, watermark advance, `consequenceOf` |
| `system` | memory server itself | space bootstrap, authorization changes — pre-existing, unchanged |

FORBIDDEN: a fourth class; per-class subtypes that alter admission;
clients producing `derived` (there must be no client code path that can
even construct one).

Threat model, stated honestly (RULED, owner 2026-08-02): the
single-deriver invariant is by construction against HONEST clients —
no client code path constructs a `derived` commit. It is NOT new ACL
protection: derived-output docs get none in v2, so a malicious client
holding today's write authority on a doc can still author into it,
docs the SpaceServer derives into and the watermark doc included
(watermark forgery is possible and accepted for now). v2 defines the
outcome, not a defense: such a write is an ordinary authored input,
and the next wave recomputes the derivation over it. v2 adds no
security guarantees beyond today's unless trivial (owner,
2026-08-02); tightening is future work.

Identity at the derived envelope (R-Q6b, RULED, owner 2026-08-02):
`derived` is a DIFFERENT TRUST CLASS from `authored`. An authored
commit crosses a trust boundary — a session did work the server
never saw, so the envelope identity is the check. A derived commit
does not: the server admitting it also DID the work, so producer
and admitter share one trust environment at the envelope, and
envelope identity verifies nothing there. The SpaceServer therefore
commits under its own service identity — the envelope principal IS
the lease holder §2 checks — and ATTRIBUTION rides WITHIN the
commit: an explicit `scope_key` on every scoped write, and the
acting principal on every action's writes (the same per-action
granularity as serving-loop.md §3c's CFC provenance). Attributed,
not signed, today. The considered alternative — N commits per wave,
one per session, each attributed at its envelope — is recorded and
rejected as the other extreme of the same axis: the wave stays ONE
commit (§7's amplification budget). Anticipated, not built:
per-user server-generated keys under user-delegated authority; when
delegation exists, attribution graduates to acting-key signatures
without changing the envelope model. CFC labels remain the
load-bearing enforcement; commit-level identity is not load-bearing
(owner).

## 2. Admission, the whole table

| commit class | checks, in order |
| --- | --- |
| `authored` doc write | session authenticated → write authority on doc/path (existing ACL) → CAS on base revision |
| `authored` event append | session authenticated → append authority on stream doc → `eventId` unique among stream entries above the stream's `eventWatermark` (CAS — the dedupe horizon, events.md §4) |
| `authored`, server-produced (outbox event append, `.inSpace` provisioning) | commit metadata carries `actingPrincipal` + `capabilityRef` → admission validates that capability grant against the target doc/stream (a delegated-capability check, NEVER session-identity impersonation) → CAS |
| `derived` | producer holds the live `execution_lease` for the space (one equality check) → CAS |
| `system` | unchanged from today |

That is the ENTIRE admission surface. No scope reasoning, no read-set
validation, no certificates: no commit ever asserts that an execution
happened elsewhere. If an admission question cannot be answered by
(target, principal, lease, CAS), the design is drifting — stop.

Note what the table does NOT do: `authored` admission checks write
authority on the TARGET only — nothing marks a doc as derived-output,
so admission protects derived docs no more than today does (§1's
threat model; the next wave recomputes over an intruding write).

## 2b. Cross-space writes

The storage layer already enforces the load-bearing rule: **one
transaction writes one space — by DEFAULT, with one explicit opt-in.**
A transaction FAILS if a writer for a different space was already
opened on it (anchor: `packages/runner/src/storage/interface.ts`
`writer(space)`) unless it opted in through `enableMultiSpaceWrites`
(`interface.ts:786`), reachable only via the `.inSpace()` chain below —
which is what makes an UNMARKED crossing always a bug. Reads cross
freely (serving-loop.md §3b; cross-space label metadata flows with
them). v2 keeps that invariant and adds the class discipline:

| crossing | mechanism |
| --- | --- |
| read a foreign doc | free — logged read + server-internal wake (§3b) |
| derive FROM foreign state | home derivation reading foreign inputs; result commits HOME |
| mutate a foreign space | **an event append to a foreign stream — the ONLY cross-space mutation** |
| `derived` commit into a foreign space | FORBIDDEN — SpaceServer(B) is B's only deriver; A never derives into B |
| provision a foreign/new space (`.inSpace`) | authored-class, foreign-first split at the wave commit step — see below |
| client authored writes to several spaces | unchanged from today: separate per-space commits, per-space ACL + CAS |

The event append crosses as an ordinary `authored` commit under the
piece's append capability, carried by the OUTBOX (serving-loop.md §5):
at-least-once, deduped by `eventId` at the target's admission, FIFO per
(source wave → target stream). The commit carries
`actingPrincipal` + `capabilityRef` metadata and the target's admission
validates that grant (§2) — delegation, never impersonation. The
target's SpaceServer processes it like any event. This matches the
codebase's own convention — patterns already mutate cross-space through
exported streams — and it is now the rule, not a style: a server action
tx that opens a foreign-space writer is a runtime error naming this
section.

**Provisioning writes — the second sanctioned crossing
(`.inSpace(...)`)**: the profile-system patterns create foreign spaces —
even mint new ones — from a handler (`profile-create.tsx`,
`ProfileHome.inSpace()`). The real chain is an explicit opt-in
end to end: `.inSpace()` → `optIntoInSpaceMultiSpaceCommit`
(`builder/pattern.ts:1084`) → `enableCrossSpaceChildCommit`
(`runner.ts:4733`, commit order `[children..., parent]`) →
`enableMultiSpaceWrites` (`interface.ts:786`) →
`commitMultiSpace`/`runSplitCommits` (`v2-transaction.ts:2077/2156` —
sequential, stop at first failure): today already foreign-first,
home-after-success. v2 keeps the API, the split, and the order,
relocated into the wave's commit step:

- Provisioning writes seal as AUTHORED-class commits into the
  destination space, under the **acting principal of the event** whose
  handler produced them (creating THEIR space — RULED; the only
  effect-authority residual is quota attribution, README §3.8),
  carried as `actingPrincipal` + `capabilityRef` commit metadata
  for the target's admission (§2). Never derived-class: single-deriver
  per space is untouched, and the minted space's own SpaceServer
  activates later (first session or event) as its only deriver.
- Sequencing at the wave commit step: foreign provisioning commits land
  FIRST (per destination space), then the home derived commit carrying
  the links and the `eventWatermark` advance. Same host, same process —
  this is store sequencing, not a network await.
- Failure: foreign fails ⇒ home never commits ⇒ the event stays
  unconsequenced and replays; persistent failure falls to the
  error-is-the-consequence rule (events.md §5).
- Replay safety: destination DIDs/ids derive from the creation event
  (CT-1650 — anonymous `inSpace()`, DID unique per user + creation
  event), so a replayed handler re-derives the SAME ids and the
  re-provisioning is a CAS no-op. The today-orphan window (foreign
  landed, home did not) becomes convergent instead of dangling.
  Provisioning handlers MUST therefore be deterministic given
  payload + cells — no clock, no randomness (events.md §3); replay
  convergence depends on it. A transformer lint can trail.
- The foreign-writer runtime error therefore narrows to ACCIDENTAL
  crossings: a server action tx may write a foreign space exactly
  where the API opted in (the `.inSpace()` chain above). Unmarked
  foreign writes remain an error naming this section — one tx, one
  space is the default, so an unmarked crossing is always a bug.
- Sharded future (spaces not co-hosted): provisioning becomes
  outbox-carried and the home commit defers a wave. Out of v2 scope.

**Atomicity, stated plainly:** nothing spanning two spaces is atomic —
not today, not in v2. A wave is per-space; cross-space influence is
asynchronous (reads/wakes inward, events outward). What v2 adds is that
the non-atomic boundary is EXPLICIT and carries defined failure
semantics: the outbox retries the append, the eventId dedupes it, and
the target's `eventWatermark` makes processing exactly-once.

## 3. Subscription and push

- Clients subscribe to docs/queries as today
  (`packages/runner/src/storage/query.ts` path). The SpaceServer
  subscribes to the whole space's accepted-commit feed from a seq.
- **Push priority** (Phase 6 hardening, but the contract is fixed now):
  when flushing a batch to a client socket, `derived` commits touching
  docs that client subscribes to go first; everything else follows.
  Bookkeeping MUST NOT ride the commit stream at all (lease renewals are
  table updates; watermarks piggyback on derived commits), so in practice
  priority is about big authored blobs vs small derived values.
- Self-echo: SpaceServer skips its own `derived` commits on receipt
  (serving-loop.md §3).

## 4. The watermark

- Definition (sharpened by the 2026-08-02 demand ruling): `W(space)` =
  highest seq such that every authored commit ≤ W has all handler
  consequences committed AND all DEMANDED derivations current through
  W (demand per serving-loop.md §1/§3b — undemanded derivations stay
  dirty-unmaterialized without holding W back).
- Carried: in every `derived` commit's metadata (`derivedThrough: W`) and
  in one well-known doc per space (updated in the same transaction; never
  its own commit).
- Client use: "settled" for a client = `W ≥ seq(my last authored
  commit)`. Integration tests MUST wait on this instead of text-polling
  (testing.md §3). Sync indicators read the same signal.
- W covers DEMANDED derivations (pull-based laziness, serving-loop.md
  §3b). Client subscriptions are demand, so a fresh subscription
  arriving after W may still trigger a recompute, whose results land in
  a later derived commit.
- The watermark is ONE integer per space. Not per-doc, not per-piece, not
  vectorized. If a consumer seems to need a finer watermark, escalate
  before building it.

## 5. The client-effect channel (Phase 4)

Session-scoped, server-computed, client-enacted effects (README §3.7).

- One doc per session at a deterministic path:
  `session/<sessionId>/effects` (exact path constant to be fixed in code;
  one constant, exported once).
- Shape: append-list of
  `{ nonce, kind, args, issuedIn: <derived commit seq> }`;
  v2 ships exactly one kind: `navigate` with
  `args = { target: <entity link> }`.
- The SpaceServer writes intents as part of ordinary derived commits
  (navigateTo's output). The session's client subscribes to its own
  effects doc, enacts, then commits an authored ack write
  `{ ackedNonce }`; the next wave retires acked entries.
- Exactly-once enactment per nonce is the CLIENT's duty (it may enact
  optimistically from speculation, then reconcile by nonce — navigation
  is reversible). Reload between intent and ack: on resubscribe the
  client sees unacked intents and enacts them; nonces make re-enactment
  detectable.
- Session lifecycle: `sessionId` is minted at client connect, persisted
  client-side across reloads, and retired explicitly on logout or by
  TTL. Effects docs are session-lifetime: a dead session's unacked
  intents retire with its effects doc. Nothing global, nothing
  cross-session.

FORBIDDEN: new kinds without a spec edit here; a push channel outside the
doc/subscription model; server-side retries of enactment.

## 6. Streaming (deferred, boundary fixed)

Settled-result-only commits are the v2 baseline; the interim loss of
LLM token streaming under the flag is ACCEPTED (owner, 2026-08-02).
If/when LLM partials ship, they use an ephemeral session channel
OUTSIDE the commit stream — partials never become commits, never touch
the watermark, never wake the serving loop. `stream-data` stays
disabled (README §3.5).

## 7. Wire-shape discipline

- Commit metadata additions in v2, complete list: `class`, `holder`
  (derived only), `derivedThrough` (derived only), `consequenceOf`
  (derived only), `eventId`/`firedAt` (event appends),
  `actingPrincipal`/`capabilityRef` (server-produced authored commits
  only — §2); plus, WITHIN a derived commit's body — attribution,
  never envelope identity (R-Q6b, §1) — the explicit `scope_key` on
  every scoped write and the acting principal on every action's
  writes. Anything further needs a spec edit here first.
- All metadata is small and fixed-shape, with one bounded carve-out:
  `consequenceOf` scales with the wave's INPUT (the events drained that
  wave), never with graph size. The v1 failure mode — 130 KB of
  serialized read links per record — is structurally impossible if this
  list is respected. A metadata field that scales with GRAPH size is
  FORBIDDEN.
- Writes inside a `derived` commit keep PER-ACTION provenance for CFC
  label purposes (serving-loop.md §3c), carried in the write PAYLOAD,
  never as commit metadata: the commit is a transport batch, never a
  label boundary. R-Q6b's attribution (§1) rides at the same
  granularity — `scope_key` per scoped write, acting principal per
  action — attributed, not signed, today; when per-user delegated
  keys exist (anticipated, not built), attribution graduates to
  acting-key signatures without changing the envelope model.
