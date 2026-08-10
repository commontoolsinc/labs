# v2 inventory: the key vocabulary (scopes.md §7 M2)

Normative inventory for the M2 re-keying, plan Phase 1 stage E. Read
[scopes.md](scopes.md) §7 first; this document assumes its
vocabulary. §3 records one ruling of its own — LD3, the shared
`scope_key` vocabulary (owner, 2026-08-03).

M2 says every in-memory identity key uses the scope NAME and never
the `scope_key` — sound only at cardinality 1, and broken the moment
one runtime holds every principal's instances. M2 named three
subsystems. There are NINE construction sites. This page is the
inventory an implementer works from, so the re-keying is a checklist
rather than a search.

## Anchors (verified on main, 2026-08-02 — re-verify before coding)

Paths are relative to `packages/runner/src/` unless another package
is named. `scope_key` vocabulary is `resolveScopeKey`
(`packages/memory/v2/engine.ts:98-126`), producing `space`,
`user:<principal>`, `session:<principal>:<sessionId>`; storage rows
are keyed `(branch, id, scope_key)`
(`packages/memory/v2/engine.ts:368-403`).

## 1. The nine sites

| # | site | current string shape | required instance dimension | identity source AT that site | OFF-arm-neutral form | runner-side key construction (RULED — §3) |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `scheduler/keys.ts:5-9` — `entityKey(address)`, type `SpaceScopeAndURI`; the dependency-graph node key | `` `${space}/${normalizeCellScope(scope)}/${id}` `` | the READ instance: dirtiness must match storage's exact-`scope_key` reader matching (`engine.ts:3024-3066`), or one principal's commit wakes every principal's node | `Pick<IMemorySpaceAddress, "space"\|"id"\|"scope">` — scope NAME only; no principal, no session | `` `${space}/${scopeKey}/${id}` `` | the §3 shared constructor |
| 2 | `runner.ts:3201-3204` — `getDocKey(cell)`; the result-pattern cache key (N37's memo) | `` `${space}/${scope}/${id}` `` | the ACTION instance whose result pattern is cached — two instances may resolve to different patterns | `cell.getAsNormalizedFullLink()` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | the §3 shared constructor |
| 3 | `runner.ts:708` (`JavaScriptActionResultCells.byScope`), `5068-5092` (get/set on `effectiveOutputScope`), `5456` (init) — per-scope result cells | `Map<CellScope, Cell<any>>` — keyed by the scope NAME enum | one result cell PER INSTANCE, not per scope name: `byScope.get("session")` returns one cell where the server needs one per session | `effectiveOutputScope = narrowestScope([...])` — a NAME derived from schema + read ratchet | `Map<ScopeKey, Cell<any>>`, key = the shared constructor over (scope, identity) | the §3 shared constructor |
| 4 | `data-updating.ts:102` — `seedMemoKey(link)`; dedupes eager scoped-property seeding | `` `${space}/${scope ?? "space"}/${id}` `` | per instance — the site's own comment already says one scope's presence must not suppress another's seed; at fan-out one USER's presence must not suppress another's | `NormalizedFullLink` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | the §3 shared constructor |
| 5 | `traverse.ts:1693` — inline coverage key passed to `schemaTrackerCoversSelector` | `` `${link.space}/${link.scope}/${link.id}` `` | per instance read: coverage proven for one instance is not coverage of another | `NormalizedFullLink` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | the §3 shared constructor |
| 6 | `traverse.ts:1962` — `getTrackerKey(address)`; the schema-tracker key | `` `${space}/${scope ?? "space"}/${id}` `` | same as 5 — one tracker entry per instance | `IMemorySpaceAddress` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | the §3 shared constructor |
| 7 | `storage/v2.ts:1247` — `registerPendingLoad`, the `#pendingLoads` key | `` `${space}/${scope}/${id}` `` | per instance: two instances of one doc are two loads, and collapsing them makes one waiter observe another's failure | `{ space, scope, id }` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | the §3 shared constructor |
| 8 | `storage/transaction/address.ts:4` — `toString(address)`; transaction-journal address identity | `` `/${normalizeCellScope(scope)}/${id}/${JSON.stringify(path)}` `` (no space — it is per-space by construction) | per instance within the wave: one action tx may seal writes to several instances of one doc (scopes.md §2) | `IMemoryAddress` — scope NAME only | `` `/${scopeKey}/${id}/${JSON.stringify(path)}` `` | the §3 shared constructor |
| 9 | `scheduler/graph-snapshot.ts:245` — `formatAddress(address)`; diagnostic graph-snapshot labels (site 1's `entityKey` is also used at `:237`) | `` `${space}/${id}/${normalizeCellScope(scope)}/${path.join("/")}` `` | per instance — diagnostic only, but a per-instance graph renders N indistinguishable rows without it, which is how a fan-out bug hides | `IMemorySpaceAddress` — scope NAME only | `` `${space}/${id}/${scopeKey}/${path.join("/")}` `` | the §3 shared constructor |

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
  exported constructor `(scope, identity) → scope_key` plus the
  parse/inspect helpers, which `engine.ts` imports in place of its
  private definitions.
- **What stays engine-owned is IDENTITY DERIVATION, not the
  format.** For `authored` traffic the memory server still derives
  the identity from the authenticated session at admission —
  `applyCommit` threads `session.principal` + `message.sessionId`
  (`packages/memory/v2/server.ts:2128-2132`) into the engine's
  write path, which constructs the key (`engine.ts:5374-5375`) —
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
  `packages/runner/src/storage/v2.ts:43`); what it must not import
  is ENGINE internals, and after the move the format is not one.
  (Evidence the boundary was already porous:
  `packages/state-inspector/scopes.ts` imports `resolveScopeKey`
  straight from `engine.ts` today — it migrates to the shared
  module with the rest — and the runner itself already reaches into
  `memory/v2` internals beyond the wire module,
  `packages/runner/src/storage/v2.ts:44-49`; those other leaks are
  out of this ruling's scope.)

Plan Phase 1 stage E is UNBLOCKED by this ruling; the migration is
one definition move ahead of the nine-site re-keying.

## 4. Tripwires

FORBIDDEN once stage E lands:

- a NEW identity key built from the scope NAME — this page is the
  complete list at the time of writing, and a tenth site is a
  regression, not an omission;
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
