# SQLite builtin: `db.exec` fails on a _deployed_ piece — bug report

**Status:** OPEN. **Dates:** found 2026-06-04, re-verified 2026-06-05.
**Context:** First dogfood of the SQLite pattern builtins (`sqliteDatabase` /
`db.query` / `db.exec`, PRs #3776 / #3848) on `lunch-poll`. The migration is
complete and **green in `cf test`**, but cannot deploy live because of this bug.
**For:** review with the sqlite-builtin owner (Berni).

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
