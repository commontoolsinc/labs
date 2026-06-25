# Lunch-Poll Storm — Root Cause: fresh-vs-resume cell-identity divergence

## STATUS — RESOLVED (shipped in PR #4360)

The storm is fixed. There are **two independent** contributing causes; fixing
**either** one resolves the symptom. We fixed the cell-identity layer.

**Cause 1 (FIXED) — cell-identity divergence (fresh vs resume).** The deployer and
browsers minted *different ids* for the same shared `ifElse`/`when` result cell, so
their cross-runtime writes were genuinely different bytes (defeating the value-equal
short-circuit) and overwrote forever. Two channels, both fixed:

- **`awaitSync` in the identity cause** — a transient resume flag was folded into the
  raw-builtin `cause` (which `createRef` deep-hashes into the result-cell id). Lifted
  out-of-band into a behavioral param, mirroring the `outputBinding` precedent
  (which moved scope out of `cause.outputSpot` for the same "must not churn" reason).
  Covers all ~11 identity-hashing builtins. (`runner.ts`/`module.ts`/map/filter/flatMap.)
- **Non-canonical schema key order** — `internSchema`'s hash is key-order-insensitive
  (value-hash sorts keys), but the *interned object* kept first-seen key order, and
  schemas serialize directly from it into content-addressed `data:` cell ids. A fresh
  deployer (interns the link schema unsorted via link serialization) and a resumed
  browser (interns it sorted via `getStandardSchema` selector standardization)
  produced different bytes → different ids. Fix: store a **key-order-canonical**
  interned object (sorted with the same `utf8SortedKeysOf` the hash already uses), so
  serialization is deterministic regardless of intern order. (`data-model/schema-hash.ts`.)

**Cause 2 (OPEN, separate — seefeld's call) — the result cells are `space`-scoped
(SHARED) and every client writes them back.** `if-else.ts` sets the result-cell scope
to the *condition's* scope; conditions over shared poll state are `space`-scoped, so
the `ifElse` *results* are shared and every runtime writes back to the one slot. If
these weren't written to shared storage by every client (computed-once /
per-client-local), divergent writers wouldn't collide. This is the deeper
architectural question in [`MULTI-USER-CONTENTION-HANDOFF.md`](./MULTI-USER-CONTENTION-HANDOFF.md)
§9 — **orthogonal** to the id fix, which resolves the storm without needing it answered.

**Verification:** memwrites 27,806 → **2,148** (−92%); `ifElse` runs ~22k → 102; the
host-add storm test 12m46s-FAIL → **2s-PASS**; `data-model` + `runner` suites green
(runner 669/669, no regressions; new `key-order canonicalization` tests prove
convergence). One browser test (`keeps header summary… in sync`) still times out, but
that is the **separate `#4210`/`#4343` strand** (async-load commit-conflict stranding:
low writes, correct summary state, asymmetric per-browser), not the schema storm.

**Correction to §3 below:** the original "channel #2 = `$defs` hoisted (fresh) vs
inlined (resume)" framing was **wrong**. Re-instrumenting both runtimes byte-for-byte
showed both forms carry the local `$defs`; they differ only in **JSON key order**,
and the divergence is `internSchema`'s **first-seen-order-wins** per-process caching
(the hash is order-insensitive, but the stored object kept first-seen order). The fix
is canonical key order in interning — *not* a `cfc.schemaAtPath` reroute. §1–§2
(awaitSync) stand as written; §3's mechanism is superseded by this section.

---

## PENDING — conditional-result scope (user vs space)

The open lever behind Cause 2, worth its own note. `ifElse`/`when`/computed
result cells **inherit the scope of their condition** — `if-else.ts` sets the
result-cell scope to the resolved scope of the condition cell — so the storm
risk is entirely a function of *what the condition reads*:

- **Condition on `PerUser` state** (e.g. `isAdmin`) → **user-scoped** result.
  Each client writes its *own* cell; there is no shared slot to contend on, so
  these **never storm**, even pre-fix.
- **Condition on `PerSpace` (shared) state** (e.g. `options`/`votes`/derived
  counts) → **`space`-scoped (shared)** result. Every connected client
  re-computes it and writes back to the *one* shared slot — the substrate the
  id-divergence rode on to produce the storm.

The id fix (#4360) makes the shared case safe by converging the ids so the
repeated writes become value-equal and terminate. But the **open architectural
question** remains: should shared-condition `ifElse`/computed results be written
back to shared storage by *every* client at all, vs. computed-once or kept
per-client-local? Resolving *that* would also stop the storm — the two levers
are independent, fix either. It is **seefeld's call** (runtime scope semantics);
see [`MULTI-USER-CONTENTION-HANDOFF.md`](./MULTI-USER-CONTENTION-HANDOFF.md) §9.

---

## Follow-ups (post-#4360)

1. **#4361 — gated memwrite trace.** Separate PR (off `main`), green, awaiting
   review; merge when approved. Adds `CF_DEBUG_MEMORY_WRITES` per-connection
   `[memwrite] c=<n>` tracing (`packages/toolshed/routes/storage/memory/memwrite-trace.ts`),
   values as `vhash` by default, raw values behind `CF_DEBUG_MEMORY_WRITE_VALUES`.
2. **otel follow-up for the trace.** Promote the gated `console.error` trace to
   structured OpenTelemetry signals (the toolshed already runs `--unstable-otel`):
   low-cardinality **metrics** (writes by scope/op) for aggregation + alerting,
   high-cardinality detail only on **sampled span events**. Cardinality design is
   the bulk of the work; complementary to the console trace, not a replacement.
3. **Scopes question (the second lever).** Should `space`-scoped `ifElse`/computed
   results be written back to shared storage by *every* client, vs.
   computed-once / per-client-local? Independent of the id fix — see the PENDING
   section above. **seefeld's architectural call.**
4. **The `#4210`/`#4343` strand** — reactive computes stranded by commit-conflict
   retries that don't converge under real async load. *Separate* from the storm;
   likely the common root behind the vote-flickering-on-reload **and** #7. Probably
   the next biggest lunch-poll thread. See `reference_reactive_conflict_strand_repro`
   (memory) + MULTI-USER "open questions"; only reproduces under real browser/CI
   async load, NOT in-process.
5. **Loop seefeld in** — on the merged canonical-interning fix (#4360, his interning
   subsystem) *and* the scopes question (#3).
6. **Deployed demo** — a local toolshed running the fix is live on the tailnet
   (`gideons-macbook-pro-1.saga-castor.ts.net/lunch-poll-fix/…`), served from
   `/tmp/cf-pr-wt`. Keep / tear down (`scripts/share-pattern-via-tailscale.sh --down`
   from there) / or redeploy from a branch with #4361 for real write metrics.
7. **Flaky `notebook reload` CI test** — "reloads every rapidly created notebook
   note" timed out on a 60s `waitFor` (cleared on re-run, so non-deterministic).
   *Hypothesis, verify don't assume:* the same compute-retry / strand convergence
   issue as #4 (not generic CI noise). Cheap first step: check its flake rate on
   `main`'s recent CI history to separate "standing issue" from "we touched it."

---

**Supersedes the framing in [`MULTI-USER-CONTENTION-HANDOFF.md`](./MULTI-USER-CONTENTION-HANDOFF.md).**
That doc said "value-identical writes losing a seq race." That premise is **wrong**
(see §1). The real cause is **cell-identity divergence between fresh-create and
resume-from-sync runtimes**, via two independent channels. Root cause is **found,
causally proven, and de-risked**; the only thing left is the precise placement of
a schema-canonicalization fix in the `cfc` derivation flow (§5, §7).

---

## 0. TL;DR
A derived cell's id (`runtime.getCell(space, cause)` → content hash, and inline
`data:` URIs → literal content hash) comes out **different** on a runtime that
**created the pattern fresh** (the harness's Deno "deployer", `rt=D`) vs one that
**resumed from synced storage** (each browser worker, `rt=W`). Same logical cell,
two ids. Because the affected `ifElse`/`when` result cells are **space-scoped
(shared)**, the deployer and the browsers perpetually overwrite the one shared
slot with their own id → a non-terminating cross-runtime ping-pong (~27k writes
for a static 3-user poll). Browsers agree with each other (same worker build +
same resume path); the deployer differs.

**Two divergence channels, both confirmed by instrumenting BOTH runtimes:**
1. **`awaitSync`** — a transient resume flag folded into the builtin `cause`, then
   hashed into the result-cell id. Present on resume, absent on fresh.
2. **Schema `$defs` placement** — the same schema serializes with `$defs`
   **hoisted** (a bare `#/$defs/X` ref, fresh) vs **inlined** locally (resume).
   It rides inside content-addressed inline cells, so the cell id diverges.

**Proof:** strip channel #1 → **−40%** writes. + canonicalize channel #2 (boundary
experiment) → the ifElse result ids **converge** (`rt=D`/`rt=W` mint the SAME id),
the ~20 ifElse storm cells vanish, writes drop **27k → 7.2k (−73%)**.

**Rapids fidelity (resolved):** the real axis is fresh-vs-resume, which happens on
rapids — the pattern is deployed once (fresh) and every client resumes-from-sync.
The harness reproduces the real bug; it is NOT a harness artifact.

---

## 1. What the OLD handoff got wrong (don't re-chase)
- **"Writes are value-identical, losing a seq race."** FALSE. Value-equal writes
  are already short-circuited at THREE places, all via the faithful content-hash
  `valueEqual` ([`data-model/valueEqual.ts:30`](../../../data-model/src/valueEqual.ts)):
  `writeWithinBranch` ([`v2-transaction.ts:1366`](../../../runner/src/storage/v2-transaction.ts)),
  `getNativeCommit` (`v2-transaction.ts:1047`), `buildValuePatchCandidate`
  (`v2-transaction.ts:471`). A value-equal write never reaches `recordPatchIntent`
  → no fact → no seq bump. So the storm's 27k `op=patch` ASSERTIONS prove the
  writes are genuinely **different** — they differ in the link **target id**
  (which is the divergent-cell-id symptom).
- **seefeld's PR #4353** (`onlyIfDifferent` on `setRawUntyped`) is a *fourth*
  value-equal skip → cannot fix divergent-value writes. **Tested empirically: no
  effect** (still ~30k storm). Fine optimization, orthogonal to this bug.
- **Wilk's PR #4349** mitigates via retry-narrowing + UI-reconciler (his harness
  passes), but does **not** fix the id divergence — its own green run still shows
  the 2-target deployer-vs-browser split. Complementary, not a root-cause fix.

---

## 2. Channel #1 — `awaitSync` in the identity-bearing cause
- The node `cause` is assembled at
  [`runner.ts:3779-3796`](../../../runner/src/runner.ts):
  ```js
  { inputs, parents: processCell.entityId, ...(resolvedOutputSpot && { outputSpot }),
    ...(defersInitialRunUntilSynced(schedulerRehydration) ? { awaitSync: true } : {}) }
  ```
  `awaitSync` is true on RESUME (`defersInitialRunUntilSynced`, `runner.ts:527-532`),
  absent on FRESH.
- `getCell(space, cause)` → `createRef` deep-hashes the WHOLE cause
  (`create-ref.ts:143`), so `awaitSync` enters the id. (`module.ts:124-125`
  literally warns `cause.outputSpot` "is hashed into result-cell causes and must
  not churn" — `awaitSync` is the thing that churns.)
- **Vulnerable builtins** (hash the whole raw cause): `ifElse` (`if-else.ts:46`),
  `when` (`when.ts:24`), `unless` (`unless.ts:24`), `fetchData`, `fetchProgram`,
  `streamData`, `compileAndRun`, `navigateTo:35`, `sqlite-builtins:76`,
  `llm/generateText/generateObject` (`llm.ts:519/828/1110`), `llm-dialog`, `wish`.
- **NOT vulnerable**: `map`/`filter`/`flatMap` result & child cells — they hash
  only `outputSpot`/`parentCell.entityId`/`elementKey`, not the whole cause
  (`map.ts:168/258`, `filter.ts:111/185`, `flatmap.ts:113/187`).
- **Proper fix:** separate `awaitSync` from the IDENTITY cause at the source
  (`runner.ts:3779`) — pass it out-of-band (a behavioral param like `outputBinding`
  already is — `module.ts:119-126`), so it never enters any cell id. One change
  covers all ~11 builtins. (`if-else.ts` currently has a per-builtin strip —
  `{ awaitSync, ...identityCause }` before `getCell` — as a partial proof; replace
  with the source fix.)

## 3. Channel #2 — schema `$defs` placement (hoisted vs inlined)
- The divergent schema is a `UIRenderable` (VNode-children) schema on a link inside
  the ifElse **inputs** cell (`/value/ifTrue/children[1]/.../link@1/schema`).
- FRESH form: `{"items":{"anyOf":[{"$ref":"…/vnode.json"},{"$ref":"#/$defs/UIRenderable"},…]}}`
  — `$defs` **hoisted** to an ancestor, bare ref, no local `$defs`.
- RESUME form: `{"$defs":{"UIRenderable":{…}},"items":{…}}` — `$defs` **inlined**
  locally (self-contained). Same logical schema; different bytes.
- The schema rides in a content-addressed inline cell: ifElse inputs are minted by
  `getImmutableCell` (`runtime.ts:1054-1077`, plain `JSON.stringify({value:data})`,
  called at `runner.ts:3703`). So the inline cell's id literally embeds the schema
  bytes → divergent id. `internSchema` (`schema-hash.ts:116`) hashes structurally,
  with NO `$defs` canonicalization, so hoisted ≠ inlined.
- **The inlining machinery** is `ContextualFlowControl.schemaAtPath`
  ([`cfc.ts:570`](../../../runner/src/cfc.ts)): as it descends a schema by path it
  threads the ancestor `$defs` down and re-attaches them at the leaf
  (`{ ...cursor, ...(defs && { $defs: defs }) }`). The RESUME path navigates
  links through `getSchemaAtPath` (callers: `data-updating.ts:939/948/1092/1139`,
  `pattern-binding.ts:94/119/406/428`, `link-resolution.ts:255`, UI-typing at
  `runner.ts:1868`) → inlines. The FRESH path attaches the **authored**
  `vnodeSchema` sub-schema (`schemas.ts:129`, hoisted; `vnode.json` registered at
  `cfc/schema-refs.ts:27`) verbatim → keeps the ref.
- **Canonical form = INLINED / self-contained.** A link schema is serialized
  standalone into a `data:` URI and read back **detached** from its ancestor, so a
  bare `#/$defs/X` ref would dangle. (UIRenderable is recursive → you can't fully
  flatten; the inlined form keeps `$defs` LOCALLY, which is correct.)
- **Fix (your idea, the right one):** make the FRESH path generate the inlined form
  by routing its schema derivation through `cfc.schemaAtPath`'s `$defs`-threading —
  i.e. ensure the VNode/inputs link schema is derived via `getSchemaAtPath(parent,
  path)` rather than attached verbatim. **Placement is the open task (§7).**

---

## 4. What was REFUTED by instrumentation (verify, don't re-trust)
- A subagent (capable, but wrong) claimed the divergence is at `pattern-binding.ts`'s
  `alias.schema (verbatim) ?? cfc.schemaAtPath` branch (403-441), serialized via
  `createSigilLinkFromParsedLink` → `sanitizeSchemaForLinks`. **Instrumenting that
  chokepoint showed BOTH `rt=D` and `rt=W` produce the INLINED form (`localDefs=true`,
  len 295).** So the hoisted (len 316) schema **never passes through there** — it's
  attached **directly** during VNode construction, then `JSON.stringify`'d into the
  inline cell, bypassing `sanitizeSchemaForLinks`. (`sanitizeSchemaForLinks` is
  `$defs`-placement-preserving; it is NOT the culprit.)
- `branchWithParentDefs` (`schema.ts:198`) inlines but is **validation-only**
  (callers in `matchesConcreteValue`/`resolveSchema`); never written onto a stored
  link schema. NOT the culprit.
- My own over-claims this session, each caught by a fuller comparison: "single vhash
  = identical values" (I'd hashed the wrong field); "awaitSync is the SOLE differ"
  (I compared `outputSpot`+key-list but not `inputs`/`parents` VALUES — `inputs` also
  diverged). **Lesson saved to memory** (`feedback_verify_full_comparison_before_sole_cause`).

---

## 5. The fix (what to build)
1. **Channel #1 (cheap, do first):** in `runner.ts:3779`, stop putting `awaitSync`
   inside the identity cause; pass it to the builtin out-of-band. `map`/`filter`/
   `flatMap` read `cause.awaitSync` for resume-batching (`map.ts:98` etc.) — give
   them the value via the behavioral channel. Then drop the per-builtin strip in
   `if-else.ts`. Covers all ~11 builtins.
2. **Channel #2 (the hard one):** make the fresh schema derivation inline `$defs`
   via `cfc.schemaAtPath` (canonical = inlined/self-contained). Most-likely fresh
   path for the VNode-children schema is the child-schema derivation in
   `data-updating.ts` (939/948/1092/1139) and/or the UI typing at `runner.ts:1868`
   (`resultCell.key(UI).asSchema(rendererVDOMSchema)` — `rendererVDOMSchema` is
   hoisted). **Validate any fix the right way** (§6): the summary assertion must
   PASS (a crude boundary canonicalization broke it — empty `pollSummary`), AND
   `rt=D`/`rt=W` must share result ids, AND the storm must collapse.
3. **Migration caveat:** any of these changes the content-addressed id of affected
   cells. Old stored ids shift. This is why it's a deliberate change (seefeld owns
   the schema subsystem; he's on vacation — proceed carefully and keep the evidence).

**Fallback if §5.2 stays elusive:** the boundary canonicalization at `getImmutableCell`
(`runtime.ts:1061`) is PROVEN to converge the ids. The crude version
(force-merge all `$defs` + deep-sort) broke reads because schemas referencing
**registry-only** defs (not in `data`) got a `$defs` lacking them. A CORRECT version:
inline ONLY the transitive `$defs` a schema actually references AND that are findable
in `data`; leave registry-only refs untouched; sort only the `$defs` map. (Drafted,
not yet run.) This is "fix at serialization," which is conceptually awkward but works.

---

## 6. Reproduction + instrumentation toolkit (all reusable, in this tree)
- **Harness:** `packages/patterns/integration/lunch-poll-two-browsers.test.ts`
  (the "matrix" version, untracked, from `origin/test/lunch-poll-browser-matrix`).
  Run: `CF_DEBUG_MEMORY_WRITES=1 PIPE_CONSOLE=1 CF_FWD_WORKER_CONSOLE=1
  CFC_BROWSER_PROFILE_COUNT=3 HEADLESS=1 deno task integration patterns
  lunch-poll-two-browsers`. Storms in the host-add phase (~30k writes, fails).
- **Server-side memwrite trace** (`toolshed/routes/storage/memory/memory.handlers.ts`,
  gated by `CF_DEBUG_MEMORY_WRITES`): logs `[memwrite] c=<conn> op id scope vhash
  paths val`. The `c=` per-connection tag is the key tool — `c=1` is the Deno
  deployer (writes the pattern code first), `c=5/6/7` are the browsers. Per-cell
  divergence = browsers agree, c=1 differs. (This hook + the value/attribution
  fields are worth upstreaming; gated off by default.)
- **Worker→page console forwarding** (so worker `console.error` is captured):
  `CF_FWD_WORKER_CONSOLE=1` (added to `integration/shell-utils.ts` goto — seeds
  `localStorage["forwardWorkerConsole"]` BEFORE login + live-applies) + `PIPE_CONSOLE=1`.
  Uses hixie's `#4342` bridge. **Gotcha:** Deno-test buffers `console.log` — use
  `console.error` for deployer-side logs to be captured.
- **`[ifelse2]` probe** (`if-else.ts`): per ifElse, logs `rt=D/W result condId
  condScope` + cause fields. Tag runtime via `typeof Deno !== "undefined" ? "D":"W"`.
  Dedup via a `globalThis` Set so it fires in both runtimes. THE key convergence
  signal: `comm -12` of D-vs-W result ids per condId.
- **Analysis pattern:** group hot space-scoped `of:fid1:…` patch writes; per cell,
  compare `c=1`'s link target id vs the browsers' agreed target id.
- **Stack-trace probe** (was in `schema-hash.ts internSchema`, now reverted): useful
  but **async-truncated** for the schema attach — V8 sync stacks die at the async
  boundary. If you retry, enable Deno `--async-stack-traces` or instrument the
  derivation sites directly.

## 7. Current tree state (gideon/lunch-poll-perf-load) — CLEAN UP before a PR
**Live debug edits (uncommitted):**
- `runner/src/builtins/if-else.ts` — `awaitSync` strip (KEEP as partial fix, or
  replace with §5.1) + heavy `[ifelse2]` logging (REMOVE).
- `integration/shell-utils.ts` — `CF_FWD_WORKER_CONSOLE` forwarding (KEEP gated, or
  remove).
- `toolshed/.../memory.handlers.ts` — `[memwrite]` value/attribution logging
  (committed earlier as `73bdfd2e4`-style; KEEP, candidate to upstream).
- `runtime.ts` getImmutableCell — (A) canonicalization **reverted to clean**.
- `schema-hash.ts`, `link-utils.ts` — probes **reverted to clean** (note: a linter
  touched these; they're clean of our probes).
**Scratch worktrees** (sibling dirs): `labs-4349` (Wilk's PR), `labs-4353`
(seefeld's PR) — both tested, can `git worktree remove`.
**Stray processes:** a 7-day-old leaked `deno test --trace-leaks ./integration/*two-browsers*`
(pid was 30041) — `kill` it.
**/tmp:** many `toolshed.*.log` and `lunchpoll-*.out` captures — disposable.

## 8. Exact next steps
1. Implement §5.1 (`awaitSync` out of identity cause at `runner.ts:3779`). Re-run;
   expect the awaitSync-only ifElse cells to converge (~−40%).
2. Implement §5.2 (fresh schema derivation → inlined via `cfc.schemaAtPath`). Start
   by instrumenting `data-updating.ts` child-schema derivation + `runner.ts:1868`
   UI typing to confirm WHICH produces the hoisted VNode schema on D. Then route it
   through `getSchemaAtPath`. Validate (§6): summary assertion PASSES + ids converge
   + storm → hundreds.
3. If §5.2 resists, ship the CORRECT boundary canonicalization (§5 fallback) and
   flag the schema subsystem for seefeld.
4. Decide canonical form formally (inlined, per §3) and the id-migration story.

## 9. Cross-refs
- PRs: `#4349` (Wilk, mitigation), `#4353` (seefeld, value-equal skip — no effect here).
- Adjacent: `#4210`/`#4343` (stranded computes), `#4292` (schema interning),
  `#4220`/`#4178` (conflict granularity).
- The `labs-perf` worktree (`gideon/perf-write-contention-wip`) has older write-drop
  docs — mostly superseded by this.
