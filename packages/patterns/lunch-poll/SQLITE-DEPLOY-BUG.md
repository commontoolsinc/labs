# SQLite builtin: `db.exec` fails on a _deployed_ piece — bug report

**Status: RESOLVED 2026-06-10 by runtime PR #3967** (Berni-approved; handler
asCell-input presync at dispatch plus a `pull()` covered-in-flight contract fix
in `packages/runner`). Dates: found 06-04, re-verified 06-05 and 06-09, root
cause and both fixes 06-09/10.

## ⚠️ Reviving this branch — checklist (written 2026-06-10)

1. **Rebase onto main once #3967 is merged.** The runtime fix alone makes
   lunch-poll work on deploy — verified on a testbed of main + this pattern with
   NO local workaround.
2. **Drop the `packages/cli/lib/callable.ts` hunk from commit `82ced8cee`**
   (keep that commit's doc changes). It was the interim CLI-only drain (PR
   #3962, closed as superseded — Berni: blanket "wait for everything to be
   synced" is the wrong general shape). It is harmless but redundant under
   #3967, and it adds a global drain to every `cf piece call`.
3. **Re-test the separate minimal `reactOn: db` repro below** against the merged
   runtime fix before carrying it forward as its own issue — it was never
   re-tested after either fix and may or may not share the cause.
4. Design discussion (options A/B/C, open questions: per-surface opt-out,
   `isQueryResultProxy` predicate, the `synced`-flag inheritance white lie)
   lives in PR #3967's description and comments.

## ✅ RESOLUTION 2026-06-09/10 — a client-side dispatch race, fully explained

**Root cause:** `cf piece call` dispatched the handler event while the watch
batches issued during piece load were still in flight. The `SqliteDb` handle is
an asCell handler input read _synchronously_ inside the handler
(`getRaw({ lastNode: "value" })`, cell.ts `.exec`); when the watch response
carrying the handle doc hadn't landed in the local replica yet, the read saw an
empty doc and the guard threw "invalid database handle". Verified by tracing the
handle doc id through both sides of the sync boundary (session-attributed): the
server returned the doc correctly in the CLI session's own piece-load batch —
the response simply arrived _after_ the handler had already run.

**The "emergent (query-count × pattern bulk)" trigger was the race's loss
condition**, not a property of any SQL construct: each query node adds watch
entries, and the per-session watch batches are answered serially, so bulk
deterministically pushes the doc-carrying response past the dispatch. The
emulated `cf test` runner never fails because loopback storage always wins the
race. The `lph-*` table, the P1–P8 build-ups, and the day-to-day flakiness of
the minimal repros are all explained by this.

**Fix (the durable one — PR #3967, merged):** three coordinated runtime changes.
(1) `storage/v2 pull()`: entries covered by an already-registered selector now
AWAIT the covering watch's in-flight promise — restoring `cell.sync()`'s
contract that resolved ⇒ data locally available (also fixed for concurrent
same-key deduped pulls). (2) `EventHandler.presyncInputs`: the handler argument
is materialized via the existing machinery (asCell fields surface as Cells
without reading their docs) and every collected Cell's `sync()` is awaited. (3)
`dispatchQueuedEvent` awaits presync before invoking the handler, fail-open.
Targeted, not global: a handler waits only on ITS OWN input docs; steady-state
coverage resolves in a microtask.

(An interim CLI-only drain in `executeResolvedCallable` — PR #3962 — was
verified first and then closed as superseded; a copy of it rides this branch in
`82ced8cee` and should be dropped on rebase, see checklist above.)

**Verified:** full unmodified lunch-poll on a freshly deployed piece —
`clearHistory`, `logVisit`, `addOption` all succeed across repeated fresh CLI
sessions; rows land in (and are deleted from) the per-piece sqlite file;
`cf test` 17/17; runner suite 553/553; cli suite 43/43.

**Still untested:** the separate minimal `reactOn: db` repro below was never
re-tested against the merged fix. Full investigation log:
`session_outputs/2026-06-09_lunch-poll-sqlite-fresh-eyes/` (01 = root cause +
CLI fix, 02 = runtime prototype, pitfalls, design discussion).

---

## ⭐ Update 2026-06-09 — isolated the trigger (post Berni's #3896 fix)

**Two facts, both verified against a server running Berni's scope fix (#3896,
`a6b6e14a8`):**

1. **#3896 fixes the minimal case but NOT the full pattern.** A _minimal_
   `PerUser`+`PerSpace` pattern with `db.query` + `db.exec` now works end-to-end
   on a deployed piece (write lands, `reactOn: db` re-queries). ✅ The full
   lunch-poll still fails: every `db.exec` (even an unrelated `clearHistory`
   doing a plain `DELETE`) throws `invalid database handle`. ❌
2. **The remaining trigger is EMERGENT — `db.query` count × pattern bulk — not
   any single SQL construct.** This is the honest, hard-won conclusion (I twice
   over-narrowed to a single cause and was wrong; the data below is what
   actually holds).

### The data (single-variable tests on the fixed #3896 server)

Two axes, neither sufficient alone:

**(A) Minimal build-up — add features to a tiny pattern: ALL pass.** P1–P8 each
WORK: `reactOn:<counter>`, cf-link col + `users.key()` bind, 2 tables, **4
db.query incl. a GROUP BY JOIN (P4)**, async `fetchData` handler, ~13 bound
handlers + big output contract, 11 `perSession` cells, many nodes between `db`
and its consumers. So no individual feature — _including 4 queries with a JOIN_
— triggers it on a minimal skeleton.

**(B) Strip-down from the real (failing) lunch-poll skeleton (`lph-*`):**

| Variant (on the full lunch-poll body, UI stripped)                            | `db.exec` on deploy |
| ----------------------------------------------------------------------------- | ------------------- |
| `lph-b` — only the `recentVisits` query (1 query)                             | ✅ works            |
| `lph-e` — `recentVisits` + a `count(*)` JOIN (2 queries)                      | ✅ works            |
| `lph-d` — `recentVisits` + the full aggregate `placeStats` (2 queries)        | ❌ fails            |
| `lph-k` — `recentVisits` + 3 more **plain** queries (4 queries, NO aggregate) | ❌ fails            |

**The contradiction that pins it down:** P4 (4 queries incl. JOIN) on a
_minimal_ skeleton WORKS, but `lph-k` (4 plain queries) on the _full lunch-poll_
skeleton FAILS. And `lph-b` (full skeleton, 1 query) WORKS. So it is the
**combination of (several `db.query` calls) × (the full pattern's bulk)** that
trips it — not the query count alone, not the pattern bulk alone, and not the
complex aggregate alone (`lph-d` shows the aggregate _can_ trip it at just 2
queries, but `lph-k` shows plain queries also trip it at 4 — so the aggregate is
an aggravating factor, not THE cause).

### Why a _read_ query breaks the _write_ handle (hypothesis for Berni)

Symptom is on `db.exec` (cell.ts:977 — the delivered `SqliteDb` handle's
`{id,tables}` value is absent on the deployed path), but the trigger is the
presence of _enough_ `db.query` nodes in a bulky pattern. Each `db.query` builds
a `sqliteQuery` node sharing the one `db` handle cell; their request-hashing /
`rowSchema` lowering / scope-stamping appears to perturb that shared handle so
its ref isn't stamped on the deployed path — only server-side, never in the
emulated `cf test` runner. Possibly a cause-identity / output-spot collision
among multiple query nodes + the write op that scales with pattern size.
(Speculative — Berni knows the internals; the `lph-*` table is the ground
truth.)

### Reproduce

`packages/patterns/lunch-poll/main.tsx` on this branch, deployed via
`cf piece
new` against a local toolshed **running #3896**, then
`cf piece call … clearHistory` (or `logVisit`) → throws. Reducing to a single
`db.query` makes all `db.exec` work. The `lph-b`/`lph-e`/`lph-d`/`lph-k`
skeletons above bracket the trigger.

### ⚠️ No clean pattern-side workaround found yet

Replacing the aggregate `placeStats` with JS aggregation did NOT unblock it
(that still leaves 4 `db.query` calls → `lph-k` shows that fails). A real
unblock needs either Berni's fix, or collapsing lunch-poll down to ~1 `db.query`
(possible but loses the separate count/stats reads). **Live cutover stays on
hold.**

---

## Update 2026-06-05 — reconciling with Berni's diagnosis

Berni's hypothesis: the `"sqlite"` cell should be **forced per-space** (the
cell-derived DB file is per-space), or scope folded into the DB id for per-user
DBs. Our follow-up confirms the diagnosis is in the right place — the handle's
scope — and adds two concrete data points:

1. **The bug is deterministic on the real `lunch-poll`** — re-verified on a
   fresh deploy on 2026-06-05; `clearHistory`/`logVisit` still throw. (A
   _minimal_ `reactOn: db` repro that failed on 06-04 happened to pass on 06-05
   — environment-sensitive — but the full pattern fails robustly. Use the full
   pattern as the reproducer, not that minimal one.)
2. **The author-side `.asScope("space")` lever is a no-op for `sqliteDatabase`,
   and does NOT fix it.** `sqliteDatabase` is a `raw()` builtin whose handle is
   allocated in its own action via
   `makeResultCell → runtime.getCell(parentCell.space, …, undefined, tx)`
   ([`packages/runner/src/builtins/sqlite-builtins.ts:41-58,138`](../../runner/src/builtins/sqlite-builtins.ts))
   — it never consults `module.defaultScope`. (Only the _pattern-node_ path
   reads `module.defaultScope`, [`runner.ts:3821`](../../runner/src/runner.ts).)
   So a pattern author cannot pin the handle's scope today, and pinning it via
   `.asScope` does nothing. **The per-space fix has to live inside the builtin /
   `makeResultCell`** — give the handle cell an explicit `"space"` scope at
   allocation (or fold scope into the DB id). Verified: adding
   `.asScope("space")` to lunch-poll's `db` left `clearHistory` still failing.

This narrows it nicely: the **write-handle materialization on the deployed path
needs the handle to carry a definite (space) scope**, which the current builtin
allocation doesn't give it in a `PerUser`+`PerSpace` pattern.

---

## TL;DR

On a **deployed piece** (`cf piece new` → `cf piece call`), any handler that
calls `db.exec(...)` throws **"invalid database handle"**. The _same pattern,
same handler_ runs fine in the **emulated `cf test` runner** (which runs a real
in-process `MemoryV2Server` with real SQLite). So `db.query` reads work
everywhere; `db.exec` writes fail **only on a deployed piece**.

We could not isolate a single-feature trigger: removing the cfLink columns, the
JOIN query, the second table, or the dangling queries each **individually fails
to fix it**. It looks like an emergent interaction specific to the deployed
handler-input materialization of the `SqliteDb` handle in a non-trivial scoped
(`PerUser` + `PerSpace`) pattern.

---

## Exact symptom

After deploying `packages/patterns/lunch-poll/main.tsx` and calling any
sqlite-mutating handler (`logVisit`, `removeHistoryEntry`, `clearHistory`):

```
Error in action: TypeError: .exec() is only available on a SqliteDb cell (invalid database handle)
TypeError: .exec() is only available on a SqliteDb cell (invalid database handle)
    at CellImpl.exec (packages/runner/src/cell.ts:977:13)
    at eval (fid1:<recipe-id>/main.tsx:<line>:5 — inside the handler body)
```

The throw is the guard at
[`packages/runner/src/cell.ts:973-979`](../../runner/src/cell.ts): `.exec()`
reads the handle with `this.getRaw({ lastNode: "value" })` and requires a string
`id`; on the deployed path the delivered handle's `{ id, tables }` value is
absent, so `typeof handle.id !== "string"` and it throws. (The comment there
already notes "handler-input materialization doesn't always stamp the kind onto
the delivered cell" — this looks like a deeper version of that: not just the
brand/kind, but the readable handle value itself is missing on deploy.)

`db.query` reads on the **same deployed piece** work fine — e.g. `recentVisits`
returns `{ pending: false, result: [...] }`. Only `db.exec` fails.

## The test-runner vs deployed-piece divergence (key clue)

- **`cf test` (emulated):** `StorageManager.emulate()`
  ([`packages/cli/lib/test-runner.ts:818`](../../cli/lib/test-runner.ts)) spins
  up a real in-process `MemoryV2Server` over a loopback transport, with real
  SQLite. `db.exec` **works** here — `lunch-poll`'s `main.test.tsx` exercises
  `logVisit` (writes `visits` + `vote_history` rows) and asserts on the results;
  **17/17 green**.
- **Deployed piece** (`cf piece new` against a local toolshed, then
  `cf piece call`): `db.exec` **fails** as above.

So the bug is in the **deployed-piece handler-input materialization** of the
`SqliteDb` handle — not in SQLite execution itself, not in the recipe/transform
(it type-checks and `--show-transformed` looks correct), and not in the emulated
path.

---

## What is NOT the cause (single-variable tests, all on a deployed piece)

We bisected on the real pattern. Each row changes ONE thing from the full
pattern and re-tests `clearHistory` (a minimal mutating handler:
`db.exec("DELETE FROM visits") ; db.exec("DELETE FROM vote_history")`):

| Change from the full pattern                                | `db.exec` on deploy |
| ----------------------------------------------------------- | ------------------- |
| _(none — full pattern)_                                     | ❌ fails            |
| − `vote_history` table + its handler writes + snapshot loop | ❌ still fails      |
| − dangling `vote_history` queries (stubbed to static)       | ❌ still fails      |
| − the `cfLink` columns only (keep all 4 queries)            | ❌ still fails      |
| − the `placeStats` JOIN query only                          | ❌ still fails      |

> ⚠️ An earlier bisect appeared to show "removing cfLink fixes it" — that step
> had **removed cfLink AND stubbed two `db.query` calls at once** (two
> variables), so it proved nothing about cfLink alone. Corrected: cfLink removal
> _by itself_ does NOT fix it.

## What does NOT reproduce it (minimal build-up, all on a deployed piece)

Minimal patterns built up toward lunch-poll's shape — **all worked** (no error):

- 1 `db` + 1 handler `db.exec`, no scope → works
-
  - `PerSpace` only → works
-
  - `PerUser` only → works
- `PerUser` + `PerSpace` + handler `db.exec`, **no `db.query`** → works
-
  - 1 `db.query` with `reactOn: <counter>` → works
-
  - cfLink column + `users.key(i)` bind → works
-
  - 2 tables + 4 queries incl. a GROUP BY JOIN → works
-
  - `Writable.perSession.of(...)` local cells → works
-
  - typed `Output` returning the query result + `[UI]` mapping it → works
-
  - a coexisting `fetchData` builtin (like the cuisine images) → works

So no single ingredient reproduces it in isolation; the full `lunch-poll`
reliably does. The trigger is some emergent combination we haven't pinned down.

---

## SEPARATE, smaller bug found along the way (also reproducible, minimal)

In a **minimal** `PerUser` + `PerSpace` pattern,
`db.query(sql, { reactOn: db })` corrupts the `db` handle delivered to handlers
— `db.exec` then throws the same "invalid database handle". Toggling exactly one
variable:

| PerUser | PerSpace | `db.query` | `reactOn`                    | `db.exec` in handler |
| ------- | -------- | ---------- | ---------------------------- | -------------------- |
| ✓       | ✓        | — (none)   | —                            | ✅ works             |
| ✓       | ✓        | ✓          | `db`                         | ❌ **fails**         |
| ✓       | ✓        | ✓          | omitted                      | ✅ works             |
| ✓       | ✓        | ✓          | a `PerSpace<number>` counter | ✅ works             |

This is **distinct** from the lunch-poll deploy bug above (which fails even with
`reactOn: <counter>`), but is its own real issue: passing `db` itself as
`reactOn` under `PerUser`+`PerSpace` should not break the write handle. Minimal
repro pattern:

```tsx
import {
  Default,
  handler,
  pattern,
  type PerSpace,
  type PerUser,
  sqliteDatabase,
  type SqliteDb,
  table,
  Writable,
} from "commonfabric";
type NameCell = Writable<string | Default<"">>;

const clear = handler<
  Record<string, never>,
  { db: SqliteDb; myName: NameCell }
>(
  (_, { db, myName }) => {
    if (myName.get()) db.exec("DELETE FROM v", []);
  },
);

interface Input {
  q?: PerSpace<string | Default<"">>;
  myName?: PerUser<string | Default<"">>;
}
export default pattern<Input>(({ myName }) => {
  const db = sqliteDatabase({ tables: { v: table({ t: "text" }) } });
  const query = db.query<{ t: string }>("SELECT t FROM v", { reactOn: db }); // <- the poison
  return { q: undefined, query, clear: clear({ db, myName }) };
});
```

Deploy it, `set myName --input '"X"'`, `step`, then `call clear '{}'` → throws.
Change `{ reactOn: db }` to omit `reactOn` (or react on a counter) → works.

---

## How to reproduce the lunch-poll deploy bug

Local toolshed (`http://localhost:8000`), any identity:

```bash
export CF_API_URL=http://localhost:8000
export CF_IDENTITY=./cf.key   # e.g. deno run -A packages/cli/mod.ts id derive "implicit trust" > cf.key
SPACE=lunch-sqlite-repro

PIECE=$(deno task cf piece new packages/patterns/lunch-poll/main.tsx -s "$SPACE" | grep -oE 'fid1:[A-Za-z0-9_-]+' | head -1)

deno task cf piece call --piece "$PIECE" -s "$SPACE" joinAs '{"name":"Host"}'
deno task cf piece step --piece "$PIECE" -s "$SPACE"

# Any of these throws "invalid database handle":
deno task cf piece call --piece "$PIECE" -s "$SPACE" clearHistory '{}'
# or, after addOption: logVisit '{"title":"Thai Kitchen"}'
```

`cf test packages/patterns/lunch-poll/main.test.tsx` passes 17/17 on the same
source — the divergence is the deployed path only.

---

## Workarounds already applied in this pattern (so the rest is shippable-once-fixed)

These are in `main.tsx` now; both are unrelated to the OPEN deploy bug above but
are real sqlite-builtin sharp edges worth fixing too:

1. **Large-integer truncation.** `@db/sqlite` binds a JS `number` as a 32-bit
   int, so a ms-epoch timestamp (`~1.7e12`) stored in an `integer` column reads
   back as a negative 32-bit-wrapped value (e.g. `1700000001000` →
   `-807048216`). Passing a `BigInt` did not help in this version. Reproduced in
   isolation against `@db/sqlite` directly (no CF layers). **Workaround:** store
   timestamps as zero-padded TEXT (`encodeTs`/`decodeTs` in `main.tsx`);
   16-digit padding keeps lexicographic `ORDER BY` equal to numeric order.
2. **`reactOn: db` stale re-query in the test runner.** With `reactOn: db`, the
   `recentVisits` query did not re-run after a committed `db.exec` in the
   emulated runner (3 history assertions went stale). Reacting on a
   `PerSpace<number>` `sqliteRev` counter that the handlers bump is reliable.
   (The spec's in-commit `rev`-bump model is meant to make `reactOn: db` work;
   it didn't here.)

---

## Pointers

- Guard that throws: `packages/runner/src/cell.ts:973-979` (`.exec`).
- Emulated test storage (works): `packages/runner/src/storage/v2-emulate.ts`,
  wired in `packages/cli/lib/test-runner.ts:818`.
- Builtin impl: `packages/runner/src/builtins/sqlite-builtins.ts`; handle types
  in `packages/api/index.ts` (`SqliteDb`, kind `"sqlite"`).
- Spec: `docs/specs/sqlite-builtin/` (esp. `01-api.md`,
  `03-database-sources.md`, `05-reactivity.md`).
- Full investigation log (this session):
  `session_outputs/2026-06-04_lunch-poll-sqlite/` —
  `02_int-truncation-finding.md`, `03_db-handle-peruser-perspace-bug.md`,
  `SESSION_SUMMARY.md`.
