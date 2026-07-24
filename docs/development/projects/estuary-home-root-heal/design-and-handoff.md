# Estuary home-root heal — design & handoff

**Status:** incident fix implemented & green · branch `ct/system-root-rollforward-loadable-stale` (off `origin/main`) · **Updated:** 2026-07-24

## What landed on this branch (the incident PR)

Both halves of the unbrick, shipped together because **neither heals alone**:

- **`d3ffceb6f` — #4936 folded in** (stream additive-required exemption +
  `defaultProfile?` + its schema-merge/home tests). Load-bearing, not
  superseded: `defaultProfile` was *actually* required-no-default in the
  deployed `home.tsx` (the schema-generator keys `required` off the `?` marker,
  not the value type), so the current pattern's migration throws without it —
  one layer past #4933's data fields — and so would element 2's roll-forward.
  #4936's own PR is closed in favour of this fold (stale 25-commit base + one
  red check; refreshed here).
- **`b1e49a2df` — element 2: the runnability backstop.** `startEnsuredDefault-
  Pattern`'s cold-start repair now escalates on **exactly one signal** —
  `isCfcMigrationRejection` (the `"CFC enforcement rejected commit"` prefix the
  runner uses at its own setup boundary) — and rolls the root forward to the
  space's CURRENT official pattern (ETag-revalidated compile), swapping identity
  + recording `displacedPattern` + materializing it. Every OTHER repair failure
  stays **fail-closed** (original error surfaces, nothing changes). One
  enforce-on test drives the full orchestration with a **functional read**
  (favorites materializes to its default, handler stream fires end to end); the
  existing fail-closed tests stay green unchanged.

Green: full `packages/piece/test/` (22 files / 258 steps) +
`cfc-additive-default-preserves-old-doc.test.ts` (3 steps).

**Deferred to a follow-up PR (the simplification):** element 1 (input/output
CFC distinction) + element 3 (migration-kind matrix). Those *retire* #4933's
per-field defaults and #4936's exemptions; they are correctness-simplifying,
not incident-critical, and element 1 hinges on the still-open role-threading
crux below. Do NOT block the unbrick on them.

---

### Original plan (below) — kept for the root-cause record

This is the resume-from-cold handoff for the Estuary "home space bricked" incident.
It captures the confirmed root cause, the PR we're building, exact code locations,
the open question that must be resolved, and the testing strategy. Written because
the working session's context is exhausted; everything needed to finish is here.

---

## TL;DR

The home-space fixes deployed overnight (#4900, #4901, #4926, #4933; live on Estuary
at commit `67abf6131`) are all **correct**, but they healed **no existing home**.
Two independent defects keep them from ever taking effect on an existing root:

1. **The CFC additive-required-default check conflates input and output cells.**
   It requires a `default` for any newly-required field, but that's only correct for
   an **input** (argument) the pattern *reads*. For an **output** (result) the pattern
   *creates*, a newly-required field is always compatible — the pattern writes it fresh.
   `favorites` is an output, so the check should never have fired on it. This is the
   root of the entire "needs a default" thread and it **subsumes #4933 and #4936**.

2. **The default-root auto-heal gates on loadability, not runnability.** It only rolls
   a stale root forward if its old pattern won't *compile*. Aged official roots compile
   fine and fail later at the CFC setup-migration, so they're left pinned to a pre-fix
   `home.tsx` forever, and the cold-start repair re-runs that same stale pattern and
   rethrows an opaque error. Fix: heal by **runnability** (the migration is the test),
   **atomically** (heal or one clear error), rolling forward to the current official
   pattern on migration failure.

The PR delivers both fixes plus a **migration-kind matrix test** that makes the
check's behavior a legible spec instead of archaeology. Goal: **simpler ongoing** —
one principled rule replaces the growing pile of per-field defaults and exemptions.

---

## Confirmed root cause (by direct observation, not inference)

Chain, each layer fixed in turn and all deployed to Estuary `67abf6131`:

1. Stored home source imported the retired `safeDateNow` → old root *unloadable*.
2. Recovery swapped it (identity moved) but never ran setup → missing
   `{ "$stream": true }` handler markers → "Handler used as lift". Fixed by
   **#4900** (running-piece swap runs setup) + **#4926** (cold-start setup repair in
   `pieces-controller.ts` `startEnsuredDefaultPattern`).
3. The repair's setup commit is rejected by CFC: `required field favorites needs a
   default to preserve old documents` (`cfc-relevant-transaction-not-prepared`),
   from `mergeRequired` in `packages/runner/src/cfc/schema-merge.ts:~349`. **#4933**
   gave the output data fields `Default<>`; **#4936** (open draft) exempts streams.

### Why the deploy healed nobody, established via browser probes on the live instance

Run from the Estuary tab console against `window.commonfabric.rt` (RuntimeClient):

- `getHomeSpaceCell()` reads the home cell through a **hardcoded read-lens**
  (`spaceCellSchema`, `packages/runner/src/runtime.ts:490-519`) — its
  `spaces/defaultAppUrl/suggestionHistory/recordSuggestion` shape is the LENS, NOT
  the user's pattern. (This is why an earlier "it's a different/custom pattern" read
  was a red herring — retracted.)
- `createPage(new URL('/api/patterns/system/home.tsx', origin), me, {run:true})`:
  **compile-cache HIT**, emits `favorites` with `"default":[]`, materializes
  `favorites: []`, full 15-key current shape. ⇒ the space's compile of the CURRENT
  `home.tsx` is correct; the compile cache is NOT stale. (Disproves the
  compile-cache-staleness hypothesis — also retracted.)
- `getPage("fid1:brERQlTY-8w6YcwsmA-WJ_9UmmJDzWP6GmkLCLeUGRw", me, false)` — the
  root's actually-pinned pattern: `favorites` = `{type:array, items:...}` with **NO
  default**, and only **10 keys** (missing the 5 handler streams). ⇒ **the root is
  pinned to an OLD `home.tsx`** (pre-#4933, pre-streams). That old pattern is the
  stale candidate the migration keeps re-running.

Airtight conclusion: current `home.tsx` compiles correctly (favorites+default, proven
by a full real-pipeline compile via `runtime.patternManager.compilePattern`), and
`mergeSchemaNode`/`mergeDefaults` (schema-merge.ts:362-372, 435) always keep a
candidate's default — so a correct candidate can **never** throw "needs a default".
The throw means the applied candidate is the **stale pinned old pattern**, and the
auto-updater never rolls it forward.

### Exactly why it never rolls forward — `pattern-updater.ts:248-270`

`PatternUpdater.#check` (`packages/runner/src/pattern-updater.ts`). For a stale
sourceless official root (`staleSourcelessRoot`, identity ≠ advertised), it probes
`loadPatternByIdentity(runningRef.identity)`; **line ~260 `if (staleRoot !==
undefined) return "current"`** — i.e. **loadable ⇒ stays pinned**. The code comment
even states it: *"A loadable stale/custom root stays pinned."* Loadability was used
as a proxy for health; it's wrong — the old pattern loads but won't migrate. The
actual roll-forward swap (lines ~333-344, sets `patternIdentity` to advertised
`entryRef`, records `displacedPattern`) only runs for **unloadable** roots.

---

## The PR: three elements (drop the corpus; keep it simple)

### 1. CFC check: distinguish input (argument) from output (result) cells  *(the Berni root fix — NEW, not started)*

- **Input, additive + required + no default → reject.** The pattern reads it; an old
  caller that never supplied it can't run. A default is genuinely required.
- **Output, additive + required → always compatible.** The pattern creates it on every
  materialization; the old doc lost nothing (no old data existed there). No default.

Verified today: `packages/runner/src/cfc/prepare.ts` runs `mergeRequired` uniformly
over `WritePolicyInput`s — there is **no argument-vs-result role at the merge**. So
this is a fix, not a confirm.

**Payoff / simplification:** `favorites` is an output → check should never fire →
**#4933 (per-field output defaults) becomes unnecessary, and #4936 (stream exemption)
is subsumed** ("streams are outputs" is a special case of "outputs are free"). One
rule keyed on cell role replaces the whack-a-mole.

**⚠️ THE OPEN QUESTION / CRUX — resolve before wiring:** how does the input-vs-output
**role** reach the CFC prepare? The merge sees a write to a target doc; it must know
whether that doc is being written as a pattern's **argument** or its **result**. If the
role is available at that layer, the fix is a clean gate on `mergeRequired`. If not, it
must be threaded down from where setup knows it. **Trace this first** —
`packages/runner/src/cfc/prepare.ts` (`candidateSchemasByTarget` ~808,
`mergeCfcSchemaEnvelopes` call sites ~835/2132/5267) and how `runSynced`/setup
classifies the writes it emits. This is the one place "not that complicated" gets
tested; do not hand-wave it.

### 2. Heal by runnability, not loadability; atomic with a clear error  *(IN PROGRESS — subagent, uncommitted on branch)*

In `packages/piece/src/ops/pieces-controller.ts` `startEnsuredDefaultPattern`
`catch (startError)` block (~582-662, the #4926 repair):

- Keep the same-identity idempotent repair FIRST (missing-markers case).
- If it throws (CFC migration rejected the commit), **roll forward to the current
  OFFICIAL pattern**: resolve the space's official source URL (reuse the existing
  `HOME_PATTERN_URL` / `DEFAULT_APP_PATTERN_URL` / `isHomeSpace` derivation in this
  file — do not hardcode home), fetch+compile it (mirror `pattern-updater.ts`
  ~295-345: `runtime.harness.resolve(new HttpProgramResolver(url, fetch))` →
  `compilePattern({...resolved, mainExport:"default"})` → `getArtifactEntryRef`), then
  in one `editWithRetry` tx record `displacedPattern`, `setMetaRaw("patternIdentity",
  entryRef)`, `setPatternSource`, and `runSynced(root, officialPattern, undefined,
  {expectedPatternIdentity: entryRef})`.
- If official identity == pinned identity (already current, failed for another reason),
  do NOT loop — go straight to the clear error.
- **Atomic clear error** on total failure: one `Error` naming WHY —
  `default-root heal failed for <space>: pinned pattern <id>#<sym> failed CFC
  migration and roll-forward to official <officialId> failed: <underlying>` with the
  underlying error as `cause`. Replaces the opaque `throw startError`.
- Fail-closed: swap+materialize in one tx; any failure leaves the root unchanged.

Leave `pattern-updater.ts` **unchanged** (revert any earlier edit there). Its
loadability gate is fine for the cases it handles; the runnability heal is the backstop
for loadable-but-unmigratable roots — and because it fires only on a *failed*
migration, **working roots (official or custom) never reach it, so custom roots are
preserved for free** (this dissolved an earlier false input concern).

### 3. Migration-kind matrix test  *(NEW, not started — replaces the vintage-corpus idea)*

A systematic matrix, not historical patterns. Axes:
`role {input,output} × kind {data,stream} × requiredness {required,optional} ×
default {present,absent} × migration {additive,mutation}` × a couple of value types.
Load-bearing cells the current code gets WRONG:
**output + additive + required + no default → must be COMPATIBLE** (both data and
stream kinds). Optional-additive → always fine; mutation → always reject;
input-required-no-default → reject. The matrix fails today on the wrong cells and
passes after element 1 — it's simultaneously the spec and the regression net.

---

## Testing strategy (why the overnight tests were blind)

Three blind spots let every fix pass green while prod failed:

1. **The heal harness ran `cfcEnforcementMode: "disabled"`** — the exact layer that
   rejects the migration was OFF (`check-update-default-pattern.test.ts:~1432`). This
   is the big one. **All heal-path tests must run enforce-on** (`enforce-explicit`).
   Make the harness DEFAULT to enforce here so a disabled test of a CFC-gated heal
   can't be reintroduced silently.
2. **Assertions checked the swap, not the run.** #4900/#4926 passed swap-shaped
   assertions while the swapped-in pattern died at setup. **Every heal case must end
   with a functional read** (the once-broken pattern actually materializes/runs — the
   required field defaults, a handler fires) — not just "identity changed".
3. **Synthetic docs ≠ real vintages.** The real failure was a root pinned to a whole
   old pattern; stubs never produced that shape. The matrix (element 3) covers the
   failure KINDS; the deferred corpus/acceptance (see Linear) covers real state.

---

## Related work / disposition

- **#4936** (draft, `ct/cfc-additive-required-durable-data-scope` branch + proposal
  `docs/development/proposals/cfc-additive-required-durable-data-scope.md`): the
  stream-exemption + `defaultProfile?` fix. **Likely superseded by element 1**
  (input/output distinction). Decide: fold its intent into element 1, or close it.
- **#4933** (merged): per-field output `Default<>`. Harmless but **made unnecessary**
  by element 1; leave as-is, note the future simplification.
- **#4900/#4901/#4926** (merged): correct prerequisites — keep.
- Deferred (Linear, see below): vintage corpus, acceptance gate, harness enforce-on
  default, explicit custom-root protection.

## Branch state

- `ct/system-root-rollforward-loadable-stale` off `origin/main`. Commits:
  `098531184` (this doc) · `d3ffceb6f` (#4936 fold) · `b1e49a2df` (element 2 +
  test). `pattern-updater.ts` untouched (its loadability gate is fine; the
  runnability backstop is the layer below it).
- Element 2's heal is **two commits, not atomic** (runSynced owns its own setup
  tx and asserts the identity is already pinned, so the swap must precede it).
  On a swap-then-materialize-fails path the root is left pinned-to-official but
  un-setup — the "already moved" state the same-identity repair heals next boot,
  never worse than the pinned-unmigratable root we started from. Documented at
  the method; acceptable, not silent.
- Next actions: (a) **acceptance-test the incident PR against a real bricked
  vintage before deploy** (CT-1902) — the deferred gate that would have caught
  this class; (b) open + deploy the incident PR; (c) follow-up PR: element 1
  (trace the role-threading crux first) + element 3 matrix, retiring #4933/#4936
  (CT-1904).
