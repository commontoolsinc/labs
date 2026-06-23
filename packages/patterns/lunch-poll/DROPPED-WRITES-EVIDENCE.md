# Shared-state writes are silently dropped under concurrency — root cause + evidence

**TL;DR.** When multiple runtimes (users) write the same document/cell concurrently,
some writes are **silently lost in canonical storage** — no error to the app, and
the loss can be **invisible and displaced** from its cause (a dropped *identity*
write silently voids every later action that depended on it). It is a **general
runtime behavior, not SQLite-specific**. The engine is **not** fundamentally
document-granular (disjoint `patch` writes with fine reads merge); the drops come
from pattern-handler write shapes that **over-conflict** — coarse, document-wide
reads plus a path-blind `set`/`delete` path — so **keying *as authored today* does
not avoid it** (§2). There is **one** mechanism; two earlier "second mechanism"
hypotheses were investigated and **refuted**.

This is reproducible and grounded in the runtime code. It is **for discussion** —
we have a root cause but **no chosen fix**.

---

## 1. The demonstration (cold-reader = canonical storage truth)

The probe opens a **fresh runtime that never subscribed** to the result graph
(`MultiRuntimeHarness.addColdSession`). Its first read materializes directly from
committed storage, bypassing every reactive/propagation hop — so the cold-auditor
count is **canonical server truth**, not a stale UI. Where cold == live but both
are below the attempted count, the writes are genuinely gone.

| storage | concurrency | landed (cold storage) |
| ------- | ----------- | --------------------- |
| plain keyed CELL (`main-indexed.tsx`) | 10 users | **18 / 30** |
| SQLite (`main-sqlite.tsx`) | 5 users | **1 / 15** |

```
# main-indexed.tsx, 3 options × 10 users (30 attempted):
  cold-auditor voteCount=18 votes.len=18   ->  WRITES DROPPED — 18/30 in storage
# main-sqlite.tsx, 3 options × 5 users (15 attempted):
  cold-auditor voteCount=1  votes.len=1    ->  WRITES DROPPED — 1/15 in storage
```

Both `cold == live` (no reactive-read lag) and stable across reps.

---

## 2. Root cause (code-grounded)

**The conflict check is two-tier**, and the distinction is the crux. (Both tiers
are pinned against a real `MemoryV2Server` in #4196's
`packages/runner/test/cell-write-conflict-granularity.test.ts`.)

- **tier-1 — `set`/`delete`: path-BLIND.** The predicate carries no field/path
  column, so any whole-doc `set`/`delete` conflicts with everything on the
  `(branch, id, scope_key)` document:
  ```sql
  -- packages/memory/v2/engine.ts:529  SELECT_SET_DELETE_CONFLICT
  WHERE branch=:branch AND id=:id AND scope_key=:scope_key AND seq > :after_seq
    AND op IN ('set','delete')
  ```
- **tier-2 — `patch`: path-overlap-gated.** Disjoint `patch` writes with *fine*
  reads **merge cleanly** — the engine is **NOT** fundamentally document-granular.
  (#4196 ARM 1: two disjoint sibling bumps both land; server merges to
  `{nameDraft:"Alice", otherSibling:1}`, neither rejected.)

So conflict granularity is decided by the **writer's recorded read-set (plus op
type)** — not by the engine being doc-locked. The drops we measure come from
**pattern-handler write shapes that over-conflict:**

- **Handler writes record COARSE reads → tier-2 overlaps everything.** A handler
  `.get()` (or resolving `.key(id)`) records a **root `[]` read**, a prefix of
  every concurrent patch path, so tier-2's overlap check always fires and even
  **distinct-key** writes collide. (`.key(id)` shares the parent entity `id` and
  only extends the path — `cell.ts:1492-1521`; primitives stay inline,
  `data-updating.ts:838-902`.) Measured: distinct-key 20 vs shared-list 19 of 50
  missing at 10 users. **So keying *as authored today* doesn't help — not because
  the engine can't discriminate fields, but because these handlers record
  document-wide reads** (+ the tier-1 blindness above). With fine reads (as a
  `$value`-bound write records), the same disjoint writes would merge (#4196).
  *(Exact read-path our handlers record vs `$value` writes is being pinned in the
  granularity prototype.)*
- **Bounded *across* documents.** Two distinct cells get distinct `id`s and never
  co-select in the conflict SQL (`scope_key` for `"space"` is the constant
  `DEFAULT_SCOPE_KEY`, `engine.ts:46-53`). Measured: a writer group on cell `list`
  drops the same whether a disjoint group hammers a *different* cell (42%) or that
  cell is idle (40%) — vs 69% when all writers share one cell.
- **Per-document, not per-user.** Because the space scope_key is constant, writer
  identity does not partition the unit — every user's write to one cell lands in
  one conflict group, so concurrency on that cell is what drives drops.
- **Retry budget = 5, then silent.** A conflicting handler commit is non-permanent
  and retries up to `DEFAULT_RETRIES_FOR_EVENTS = 5`
  (`scheduler/constants.ts:5`). The commit is **fire-and-forget — not awaited**
  (`events.ts:609-616`), so `send()` resolves and the run "succeeds" regardless. On
  exhaustion the runtime logs one `schedule-error` line (`events.ts:661`) but
  **nothing propagates to the app/caller**.

Re-run confirms the accounting in the simple case: every dropped write is exactly
one logged exhaustion (`missing == exhaustions`, e.g. 45 = 45 across modes).

---

## 3. The blast radius: drops **cascade** (the dangerous part)

A dropped write is not always the user-visible symptom — it can be an **identity
or setup write** whose loss silently invalidates everything downstream.

Concretely in the lunch poll: `joinAs` writes the *contended* `usersByName` /
`userOrder` docs **and** sets the user's `myName` (`PerUser`) **in the same
transaction** (`main-indexed.tsx:156-177`). Under concurrent joins, some join
transactions exhaust retries and drop — taking the `myName.set()` with them. That
user now has an empty `myName`, so `castVote`'s first line
`if (!me || !optionId) return` (`main-indexed.tsx:246`) makes **every vote they
cast silently no-op** — no write, no error, no exhaustion line.

Measured directly: at 3×10, instrumenting the guard showed **9 `castVote`s firing
with `me=""`**. So the symptom ("my votes don't count") appears nowhere near the
actual fault (a dropped *join* one phase earlier). The failure is both **invisible**
(no error at either point) and **displaced** (logged, if at all, against a
different action). This is why "the client should know" matters more than it first
sounds.

---

## 4. What it is NOT (two refuted hypotheses)

The lunch-poll case showed `missing(12) > exhaustions(6)`, which *looked* like a
**second, silent** drop mechanism. It is not — it is the cascade above (the extra
missing votes were never *attempted* as writes; their root drop was logged at the
*join* phase). Two structural hypotheses were tested in a minimal SQLite-free repro
and **both refuted**:

- **"Silent lost-update on the shared-subrecord write shape"** — a minimal handler
  mirroring `castVote` exactly (`tally.get()` then `tally.key(b).key(leaf).set()`)
  shows `missing == exhaustions`, **no silent loss**.
- **"The multi-bucket structure causes it"** — at 1, 2, and 3 shared buckets the
  minimal repro is identically clean (`missing == exhaustions`). The contention
  pattern is not the trigger.

So there is **one** mechanism (over-conflict → retry exhaustion → silent drop),
which manifests directly *and* via the cascade. (The earlier `main-sqlite-rev.tsx`
lost-update line in `PERF-SESSION` is superseded by this.)

---

## 5. Severity

- **Silent to the app** — `send()` resolves; no exception, no Result error.
- **Keying *as authored today* does not save you** — distinct-key writes still
  collide because the handler records coarse, document-wide reads (not because the
  engine is doc-locked; with fine reads they'd merge — #4196). "Give each user
  their own slot" only pays off once the recorded read-set is finer.
- **Cascading + displaced** — a dropped identity/setup write silently voids
  dependent actions far from the fault.
- **Threshold scales with contention** — plain cells drop by ~10 concurrent writers
  to one doc; SQLite by ~5 (it adds a shared `handle.rev` RMW + a wider commit
  window); the `sqliteRev` variant by ~2–3. So SQLite-per-row is **worse**, not
  better — it reintroduces and multiplies the shared funnel.

---

## 6. Fix surface (directions, not a chosen fix)

Per team discussion (Robin): for a *genuine* read-modify-write of the same value (a
shared counter, a toggle) there is **no perfect resolution** — that fundamentally
needs optimistic concurrency, and the priority is that the **client is told**
rather than silently losing the write. Our findings split the space in two:

1. **Surface exhaustion to the caller (always).** Propagate a write failure after
   the retry budget to the app instead of fire-and-forget + log-only
   (`events.ts:609-616, 661`) — at minimum an observable error the app can
   retry/queue/show. This is the headline ask and covers the cascade (where the
   symptom is otherwise invisible).
2. **Don't conflict where writes are independent.** The engine's tier-2 `patch`
   path **already** merges disjoint writes when reads are fine (#4196's real-server
   test proves it) — so the lever is making handler writes record **finer reads**
   (stop the root `[]` read so the existing path-overlap check discriminates), plus
   making the tier-1 `set`/`delete` path path-aware. The non-negotiable invariant:
   never under-record a read the handler actually depended on (that would turn
   over-conflict into a *silent lost update* — strictly worse). Alternatives: split
   hot collections so each key is its own entity doc; or CRDT/server-merge for
   commutative ops. *(Granularity options + a prototype plan are being worked
   separately.)*
3. **Mitigations (rate, not structure):** larger retry budget + jittered backoff —
   cheaper, reduces the drop *rate* under bursts, but a hot doc with N > budget
   concurrent writers still drops.

**Related work.** [#4196](https://github.com/commontoolsinc/labs/pull/4196)
(per-key commit queue + bounded rebase, runtime-client) is the **client-side
recovery** half: it serializes one client's same-key writes and *re-lands* a
rejected write instead of clobbering. It deliberately does **not** change engine
granularity ("that hardening stays with #4178") and ships the
`cell-write-conflict-granularity.test.ts` real-server harness this doc's two-tier
model is pinned against. #4196 = recover at the client; #4178 = stop
over-conflicting at the engine.

---

## 7. Reproduce

```bash
cd labs-perf

# Lunch-poll: the cascade case (cell storage, 10 users) and SQLite (5 users):
deno run -A packages/patterns/lunch-poll/probe-sqlite-landing.ts --program=main-indexed.tsx --case=3x10 --rounds=3
deno run -A packages/patterns/lunch-poll/probe-sqlite-landing.ts --program=main-sqlite.tsx  --case=3x5  --rounds=3

# Minimal, SQLite-free, no lunch-poll: plain cell drops + names which writes vanish.
# Compare missing vs the "exhausting all retries" stderr count (they match -> one mechanism).
deno run -A packages/patterns/write-contention/probe.ts --users=10 --rounds=5 --mode=map 2>/tmp/wc.err
grep -c "exhausting all retries" /tmp/wc.err

# Conflict unit is the document, not the space (disjoint cells don't contend):
deno run -A packages/patterns/write-contention/probe-space.ts --groupA=10 --groupB=10 --rounds=5
```

`--case=N×U` = N options × U users; attempted distinct votes = `N × U`.

Full methodology (re-validation, the concurrency sweep, the structural grounding)
is in [`PERF-SESSION-2026-06-15.md`](./PERF-SESSION-2026-06-15.md).

---

## 8. Open / not yet done

- **No chosen or implemented fix** — section 6 is candidate directions.
- **Headless only.** Reproduced on the real runtime stack run headless (cold == live,
  no reactive lag); a live toolshed/browser deployment repro would make it airtight
  against "but production differs."
- *Separate, not this issue:* the SQL-backed **reactive-read** lag (low live counts
  at low concurrency where storage is actually full) is a read-side propagation gap,
  not the cause of the losses here.
