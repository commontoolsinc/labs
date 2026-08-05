# v2 inventory: the key vocabulary (scopes.md §7 M2)

Normative inventory for the M2 re-keying, plan Phase 1 stage E —
LANDED (the nine §1 sites construct instance keys via the shared
vocabulary). Read [scopes.md](scopes.md) §7 first; this document
assumes its vocabulary. §3 records one ruling of its own — LD3, the
shared `scope_key` vocabulary (owner, 2026-08-03).

M2 said every in-memory identity key used the scope NAME and never
the `scope_key` — sound only at cardinality 1, and broken the moment
one runtime holds every principal's instances. M2 named three
subsystems; the closure of STORAGE-ROW-ALIGNED identity construction
— every key that must match a storage row's exact `scope_key`, which
is what stage E re-keyed — is NINE construction sites (§1). Name-keyed
identity structures that are not storage-row-aligned remain,
deliberately: §5 is their inventory, each with a disposition. This
page is the inventory both lists are held to — §4's tripwires police
it.

## Anchors (re-verified at the stage-E review fix batch, 2026-08-05)

Paths are relative to `packages/runner/src/` unless another package
is named. The `scope_key` vocabulary lives in the wire-shape module
(LD3, §3): `resolveScopeKey` plus the parse/inspect helpers
(`packages/memory/v2.ts:35-196`, beside `CellScope` at `v2.ts:26`),
producing `space`, `user:<principal>`,
`session:<principal>:<sessionId>` (components
encodeURIComponent-encoded, so `:` splits segments exactly); storage
rows are keyed `(branch, id, scope_key)`
(`packages/memory/v2/engine.ts:160`, `:177`), constructed at
admission through the same shared definition (`engine.ts:2031-2032`).

## 1. The nine sites

Each site keys per scope INSTANCE: the shared constructor over
(scope, identity), where the identity arrives WITH the work — in the
OFF arm, the runtime's own authenticated session
(`Runtime.scopeKeyIdentity`, delegating to
`IStorageManager.scopeKeyIdentity()`).

| # | site | instance key | required instance dimension | identity source AT that site |
| --- | --- | --- | --- | --- |
| 1 | `scheduler/keys.ts:26-33` — `entityKey(address, identity)`, type `SpaceScopeAndURI`; the dependency-graph node key (also the composite constructor `addressesToPathByEntity` at `reactive-dependencies.ts:81-95` builds through) | `` `${space}/${scope_key}/${id}` `` | the READ instance: dirtiness must match storage's exact-`scope_key` row keying, or one principal's commit wakes every principal's node | threaded per call from the scheduler's state (`scopeKeyIdentity` thunks wired to the runtime) |
| 2 | `runner.ts:3382-3387` — `getDocKey(cell)`; the result-pattern cache key (N37's memo; the notification-invalidation twin at `runner.ts:1207-1214` matches it) | `` `${space}/${scope_key}/${id}` `` | the ACTION instance whose result pattern is cached — two instances may resolve to different patterns | `this.runtime.scopeKeyIdentity` |
| 3 | `runner.ts:749` (`JavaScriptActionResultCells.byScope`), `5086-5110` (get/set on the resolved `effectiveOutputScope` key), `5513` (init) — per-instance result cells | `Map<ScopeKey, Cell<any>>` | one result cell PER INSTANCE, not per scope name: a name-keyed `byScope.get("session")` would return one cell where the server needs one per session | `this.runtime.scopeKeyIdentity`, resolved over the discovered `effectiveOutputScope` |
| 4 | `data-updating.ts:110-114` — `seedMemoKey(link, identity)`; dedupes eager scoped-property seeding | `` `${space}/${scope_key}/${id}` `` | per instance — one instance's presence must not suppress another's seed; at fan-out one USER's presence must not suppress another's | `runtime.scopeKeyIdentity` at the call sites |
| 5 | `traverse.ts:1725-1731` — coverage key passed to `schemaTrackerCoversSelector` (constructed via site 6's `getTrackerKey`) | `` `${space}/${scope_key}/${id}` `` | per instance read: coverage proven for one instance is not coverage of another | `TraversalContext.scopeKeyIdentity` (the traversal's acting identity; the memory server's query path supplies the querying session's — `packages/memory/v2/query.ts`) |
| 6 | `traverse.ts:1996-2003` — `getTrackerKey(address, identity)`; the schema-tracker key | `` `${space}/${scope_key}/${id}` `` | same as 5 — one tracker entry per instance | `TraversalContext.scopeKeyIdentity` |
| 7 | `storage/v2.ts:1366-1369` — `registerPendingLoad`, the `#pendingLoads` key (built with site 1's `entityKey`, which the scheduler cross-matches in `collectPendingLoadParkKeys`) | `` `${space}/${scope_key}/${id}` `` | per instance: two instances of one doc are two loads, and collapsing them makes one waiter observe another's failure | the manager's own `scopeKeyIdentity()` |
| 8 | `storage/transaction/address.ts:17-20` — `toString(address, identity)`; notification-differential address identity (`storage/differential.ts`, whose `toKey` shares the vocabulary) | `` `/${scope_key}/${id}/${JSON.stringify(path)}` `` (no space — per-space by construction) | per instance within a batch: one batch may carry several instances of one doc (scopes.md §2), and they must not collapse to one change entry | the owning session's identity, threaded through `Differential.create/load/checkout` from the replica |
| 9 | `scheduler/graph-snapshot.ts:257-264` — `formatAddress(address, identity)`; diagnostic graph-snapshot labels (site 1's `entityKey` at `:140`/`:151`/`:247`) | `` `${space}/${id}/${scope_key}/${path.join("/")}` `` | per instance — diagnostic only, but a per-instance graph renders N indistinguishable rows without it, which is how a fan-out bug hides | `SchedulerGraphSnapshotState.scopeKeyIdentity` |

## 2. Why the OFF arm does not move

Stage E is declared OFF-ARM NEUTRAL (plan Phase 1 stage E), and the
argument is structural rather than empirical: in the OFF arm each
runtime derives ONLY its own instances, so scoped cardinality is
exactly 1 per (runtime, scope). The instance dimension is therefore
DERIVABLE from the authenticated session at every site above —
`space` → `space`, `user` → `user:<me>`, `session` →
`session:<me>:<sid>` — and the re-keyed string partitions state into
exactly the same equivalence classes the scope-NAME string did. The
key text changes; no two things that were distinct merge, and no two
things that were merged separate.

That is what makes this stage landable dark, ahead of everything
that depends on it. It is also the test: an implementation whose OFF
arm moves has re-keyed by something other than the runtime's own
resolved identity, and is wrong.

## 3. The twin column — RULED (ledger LD3, owner 2026-08-03)

The last column was OPEN on one question, not nine: **who owns the
runner-side `resolveScopeKey` twin, and is importing engine
vocabulary into the runner legal layering?** The transaction
identity model (protocol.md §1) answers it, and the answer is the
middle of the three shapes the question recorded — the vocabulary
moves DOWN, and the engine imports it too — reached by modeling,
not coin flip:

- **`scope_key` is now WIRE vocabulary, so it cannot stay
  engine-internal.** Under the model, server-driven commits carry
  explicit keys inside — addressing per scoped write, attribution
  per action run (protocol.md §1/§7) — and lease-holder reads name
  `entity_scope_key` on the wire (protocol.md §2). A format both
  endpoints speak on the wire is protocol vocabulary by
  construction. Its home is the wire-shape module —
  `packages/memory/v2.ts`, where `CellScope`, `SessionId`, and the
  other protocol types already live (`v2.ts:22-26`) — as ONE
  exported constructor `(scope, identity) → scope_key`
  (`v2.ts:120-147`) plus the parse/inspect helpers, which
  `engine.ts` imports in place of private definitions
  (`engine.ts:55-59` — it re-exports the same objects, so
  `Engine.resolveScopeKey` IS the shared one, never a twin).
- **What stays engine-owned is IDENTITY DERIVATION, not the
  format.** For `authored` traffic the memory server still derives
  the identity from the authenticated session at admission —
  `applyCommit` threads `session.principal` + `message.sessionId`
  (`packages/memory/v2/server.ts:2060-2063`) into the engine's
  write path, which constructs the key (`engine.ts:2031-2032`) —
  via the shared definition. Clients never name keys — their
  identity rides the session, established at session open, never
  the commit (protocol.md §1) — so the derivation step is admission
  machinery and never exists client-side.
- **The runner gets NO resolver at all — construction only.** A
  runner-side run never resolves identity from ambient state (§4's
  tripwire): its identity arrives explicitly — the DEMAND supplies
  it for derivations, the server-stamped `firedAt` for handlers
  (scopes.md §5) — and the nine sites construct keys from
  (scope, identity) with the shared constructor. In the OFF arm
  that identity is the runtime's own authenticated session, which
  is §2's neutrality argument restated.
- **Layering: legal, and no new dependency direction.** The runner
  already imports memory-v2 protocol vocabulary
  (`@commonfabric/memory/v2` — e.g.
  `packages/runner/src/storage/v2.ts:21-40`); what it must not
  import is ENGINE internals, and the format is not one.
  (`packages/state-inspector/scopes.ts` and `conflicts.ts` import
  `resolveScopeKey` from the shared module; the runner's remaining
  reaches into `memory/v2` internals beyond the wire module are out
  of this ruling's scope.)

Plan Phase 1 stage E LANDED on this ruling: the definition move
(one shared constructor, engine re-exports) ahead of the nine-site
re-keying, exactly as ruled.

## 4. Tripwires

FORBIDDEN once stage E lands:

- a NEW identity key built from the scope NAME — §1 plus §5 is the
  complete inventory at the time of writing: a tenth
  storage-row-aligned site is a regression, not an omission, and a
  new name-keyed identity key (or a change to a §5 boundary site)
  that does not update §5's list in the same change fires this
  tripwire too;
- two definitions of the `scope_key` string format (LD3 ruled: the
  wire-shape module `packages/memory/v2.ts` owns the ONE definition
  — §3; the engine's row keys and the runner's in-memory keys
  import it, never restate it);
- deriving an instance key from anything but a resolved identity
  (a positional index, an insertion counter, a "current user"
  global) — instance keys are addresses, and an address that is not
  derived from the principal cannot be matched against a storage
  row;
- re-keying the OFF arm by anything but the runtime's own
  authenticated session (§2's neutrality argument is the gate).

## 5. The name-keyed boundary surface

§1's nine sites are the closure of storage-row-aligned identity
construction — every key that must match a storage row's exact
`scope_key`. They are NOT every name-keyed identity structure in the
tree. The sites below still key by scope NAME (or by no identity at
all); each carries its disposition and its
cardinality-greater-than-1 failure mode. This list is held-to
inventory, not observation: §4's first tripwire covers it — a new
entry, or a change to a listed one that does not update this
section, fires it.

**M4-coupled** — the wire still carries scope NAMES, so these re-key
WITH stage F's M4 push re-key, not before:

- `storage/selector-tracker.ts:13-14` — `toKey`,
  `${scope-name}\0${id}` over the subscription selector set. Failure
  at cardinality > 1: A's watch dedupes B's, so B never subscribes.
- `storage/v2.ts:843` — `#docPullKicks` (keys built in
  `shouldPullDoc`, `:1310-1327`, via `docKey`, `:2043-2044`).
  Failure: A's kick suppresses B's pull, and B's doc never loads.
- the server's wake/sync dirty keys — `toDirtyKey` =
  `${scope-name}\0${id}` (`packages/memory/v2/query.ts:773-776`;
  marked at `server.ts:2092-2098`, dirty sets at `server.ts:845-847`;
  the per-session sync cache derives its tracked ids through the
  same call, `server-sync.ts:65`, and keys its entity cache
  `${branch}\0${scope-name}\0${id}`, `server-sync.ts:16-20`). This
  is scopes.md §7 M4 itself: sound while each session re-evaluates
  only its own instance; cross-instance dirty collapse once one
  server hosts every instance.

**Stage-F serving hazards** — per-instance run identity (scopes.md
§7 M1) territory; re-key in the stage-F serving work:

- `runtime.ts:1597` — `missingDocLoadKicks` (key at `:1619`,
  `${space}\0${scope-name}\0${id}`). Failure: A's kick suppresses
  B's load, so B's absent read never heals.
- `scheduler/wake-shaping.ts:340-347` — `linkKey`
  (`space|scope-name|id|path`), plus the pieceId buckets
  `${scope-name}:${id}` (`runner.ts:3396`, `:5433`). Failure: shaper
  groups and rate caps collapse across principals — cross-principal
  budget consumption, and a timing channel that correlates one
  principal's activity with another's wakes.

**Recorded sound-per-session:**

- `packages/memory/v2/query.ts:141`, `:179`, `:199` — the
  `EngineObjectManager` caches key `${scope-name}/${id}/${type}`
  with no principal, and are sound because the constructor binds ONE
  identity per manager (`query.ts:114-120`): every entry a manager
  holds was read as that identity. Re-key only if the manager
  sharing model ever changes.

**Identity-bound invariant** (guard owed at stage F):

- the shared schema memo — `schemaMemoAddressKey`
  (`traverse.ts:190-196`) has no identity component, and every
  sharing scope is single-identity today: `TrackedGraphState.memo`
  is bound to its manager (`packages/memory/v2/query.ts:54`), and
  the query path's `sharedMemo` instances are per-call
  (`query.ts:347`, `:557`). Sharing one memo across identities is
  FORBIDDEN — schema narrowing memoized under one principal's
  traversal would leak into another's (value-bleed). An explicit
  guard or assertion is owed at stage F before any cross-run memo
  sharing lands.

**Instance-safe transients** (why each is fine as-is):

- `pending:`/`confirmed:` dependency-dedupe keys
  (`storage/v2.ts:707-713`) — per-commit-assembly lifetime; a key
  never outlives the one identity building that commit.
- `#pendingAsyncWork` owner keys (`runtime.ts:1206`, keys at
  `:1224-1227`) — conservative direction: a name-keyed owner match
  can only make `settledFor` wait for MORE work, never return early.
- `fixtureDocKey` (`traverse-recorder.ts:75-80`) — dev capture
  tooling; fixture identity, not runtime identity.

**A recorded enablement gate** (from the stage-E re-key itself): the
coverage memo is consulted only for links that DECLARE a scope
(`traverse.ts:1700-1716`). Enabling it for unscoped links is gated
on first resolving the html reconciler's
`get({ traverseCells: true })` value consumption, and is a separate,
deliberate change — never a side effect of re-keying.
