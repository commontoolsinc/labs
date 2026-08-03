# v2 inventory: the key vocabulary (scopes.md §7 M2)

Normative inventory for the M2 re-keying, plan Phase 1 stage E. Read
[scopes.md](scopes.md) §7 first; this document assumes its
vocabulary and adds no new rulings.

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

| # | site | current string shape | required instance dimension | identity source AT that site | OFF-arm-neutral form | runner-side `resolveScopeKey` twin |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `scheduler/keys.ts:5-9` — `entityKey(address)`, type `SpaceScopeAndURI`; the dependency-graph node key | `` `${space}/${normalizeCellScope(scope)}/${id}` `` | the READ instance: dirtiness must match storage's exact-`scope_key` reader matching (`engine.ts:3024-3066`), or one principal's commit wakes every principal's node | `Pick<IMemorySpaceAddress, "space"\|"id"\|"scope">` — scope NAME only; no principal, no session | `` `${space}/${scopeKey}/${id}` `` | OPEN (ledger LD3) |
| 2 | `runner.ts:3201-3204` — `getDocKey(cell)`; the result-pattern cache key (N37's memo) | `` `${space}/${scope}/${id}` `` | the ACTION instance whose result pattern is cached — two instances may resolve to different patterns | `cell.getAsNormalizedFullLink()` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | OPEN (ledger LD3) |
| 3 | `runner.ts:708` (`JavaScriptActionResultCells.byScope`), `5068-5092` (get/set on `effectiveOutputScope`), `5456` (init) — per-scope result cells | `Map<CellScope, Cell<any>>` — keyed by the scope NAME enum | one result cell PER INSTANCE, not per scope name: `byScope.get("session")` returns one cell where the server needs one per session | `effectiveOutputScope = narrowestScope([...])` — a NAME derived from schema + read ratchet | `Map<ScopeKey, Cell<any>>`, key `resolveScopeKey(scope, identity)` | OPEN (ledger LD3) |
| 4 | `data-updating.ts:102` — `seedMemoKey(link)`; dedupes eager scoped-property seeding | `` `${space}/${scope ?? "space"}/${id}` `` | per instance — the site's own comment already says one scope's presence must not suppress another's seed; at fan-out one USER's presence must not suppress another's | `NormalizedFullLink` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | OPEN (ledger LD3) |
| 5 | `traverse.ts:1693` — inline coverage key passed to `schemaTrackerCoversSelector` | `` `${link.space}/${link.scope}/${link.id}` `` | per instance read: coverage proven for one instance is not coverage of another | `NormalizedFullLink` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | OPEN (ledger LD3) |
| 6 | `traverse.ts:1962` — `getTrackerKey(address)`; the schema-tracker key | `` `${space}/${scope ?? "space"}/${id}` `` | same as 5 — one tracker entry per instance | `IMemorySpaceAddress` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | OPEN (ledger LD3) |
| 7 | `storage/v2.ts:1247` — `registerPendingLoad`, the `#pendingLoads` key | `` `${space}/${scope}/${id}` `` | per instance: two instances of one doc are two loads, and collapsing them makes one waiter observe another's failure | `{ space, scope, id }` — scope NAME only | `` `${space}/${scopeKey}/${id}` `` | OPEN (ledger LD3) |
| 8 | `storage/transaction/address.ts:4` — `toString(address)`; transaction-journal address identity | `` `/${normalizeCellScope(scope)}/${id}/${JSON.stringify(path)}` `` (no space — it is per-space by construction) | per instance within the wave: one action tx may seal writes to several instances of one doc (scopes.md §2) | `IMemoryAddress` — scope NAME only | `` `/${scopeKey}/${id}/${JSON.stringify(path)}` `` | OPEN (ledger LD3) |
| 9 | `scheduler/graph-snapshot.ts:245` — `formatAddress(address)`; diagnostic graph-snapshot labels (site 1's `entityKey` is also used at `:237`) | `` `${space}/${id}/${normalizeCellScope(scope)}/${path.join("/")}` `` | per instance — diagnostic only, but a per-instance graph renders N indistinguishable rows without it, which is how a fan-out bug hides | `IMemorySpaceAddress` — scope NAME only | `` `${space}/${id}/${scopeKey}/${path.join("/")}` `` | OPEN (ledger LD3) |

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

## 3. The open column (ledger LD3)

The last column is OPEN for all nine rows, and it is one question,
not nine: **who owns the runner-side `resolveScopeKey` twin, and is
importing engine vocabulary into the runner legal layering?**

The bind is concrete. Every site above holds a
`NormalizedFullLink` / `IMemorySpaceAddress`, which carries the
scope NAME and nothing else. `resolveScopeKey` — the one function
that turns (scope, principal, sessionId) into a `scope_key` — lives
in `packages/memory/v2/engine.ts` and is not imported by the runner
today. Three shapes were considered and NONE is ruled:

- the runner imports the engine's `resolveScopeKey` (fewest
  definitions, but the runner takes a dependency on memory-server
  internals);
- the vocabulary moves down to a package both layers already depend
  on, and the engine imports it too (one definition, one migration);
- the runner grows its own twin (no new dependency, two definitions
  of one format — the duplication this repo's own conventions warn
  about).

This blocks plan Phase 1 stage E and therefore M2. It needs an
owner/architecture ruling, not a coin flip in a PR.

## 4. Tripwires

FORBIDDEN once stage E lands:

- a NEW identity key built from the scope NAME — this page is the
  complete list at the time of writing, and a tenth site is a
  regression, not an omission;
- two definitions of the `scope_key` string format (whatever LD3
  rules, the format is defined ONCE — the engine's row keys and the
  runner's in-memory keys must never drift);
- deriving an instance key from anything but a resolved identity
  (a positional index, an insertion counter, a "current user"
  global) — instance keys are addresses, and an address that is not
  derived from the principal cannot be matched against a storage
  row;
- re-keying the OFF arm by anything but the runtime's own
  authenticated session (§2's neutrality argument is the gate).
