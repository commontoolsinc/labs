# S16 — filter/flatMap input-read over-taint (verified; fix is NOT "mirror map")

_Started 2026-06-29 out of the #4367 review; **substantially revised 2026-06-29**
after instrument-validated verification + seefeld's reframe. The earlier plan in
this doc ("port map's identity-only input materialization to filter/flatMap") is
**WRONG — it's a security regression.** Read the TL;DR before acting. Companion to
[`OPEN-THREADS.md`](./OPEN-THREADS.md)._

## TL;DR (revised)
- The over-taint is **real and observable on the persisted result**: filter's
  input-list read (`filter.ts:156` `inputsCell.asSchema(FILTER_INPUT_SCHEMA).get()`)
  dereferences **every** element (arrays "dereference one more link",
  `traverse.ts:3460-3495`) and joins each element's whole-doc content label into
  the coordinator's per-tx `J`, which stamps the result container's **`structure`**
  label — even elements the predicate never read. Verified by direct
  read of the resolved container's labelMap (not a dereferencing probe). This is a
  genuine violation of the member-vs-structure separation (spec **§8.5.6.1**).
- **BUT it is conservative / fail-safe, and it is load-bearing.** The same input
  read is currently the **sole carrier of the legitimate §8.5.6.1 membership
  taint.** Porting map's identity-only materialization removes the over-taint AND
  the membership taint: the team's own `cfc-flow-pointwise` filter tests
  (`shape-only reader…`, `empty result … membership taint`) **go red**. So the
  naive fix trades a fail-safe over-taint for a **fail-open membership-confidentiality
  leak.** Do not do it. (#4391's container-read change is separately label-neutral.)
- **Root cause (traced, confirmed):** the membership taint's *correct* carrier is
  the **predicate-result reads** the coordinator consumes. With the input leak
  removed they ARE precise (`[alice]` for el0, `[bob]` for el1) and the coordinator
  DOES read them — but they only settle on the **second** reconcile pass, by which
  time the container value is unchanged, so **`skip-if-unchanged` elides the write
  and its `structure` stamp never fires** (verified: 0 structure stamps emitted
  with the fix; the unfixed code stamps `[alice,bob]` on pass 1 via the leak).
  **The leak was masking a label-stamp-timing bug.**
- **A precise fix is feasible AND BUILT — Stage 2 is complete.** The robust fix:
  (1) identity-only input read on filter/flatMap (removes the over-taint, breaks the
  feedback loop so predicate results become precise); (2) a coordinator→prepare
  signal (`tx.recordCfcStructureContainer`) so prepare **re-derives the container's
  `structure` label from the per-tx J every reconcile, decoupled from value writes**
  (membership taint settles a pass after the root write; this lands it robustly).
  map opts out (no membership secret → stays clean). **Verified: over-taint REMOVED
  (index-drop → `structure=[]`), membership PRESERVED (isPositive → `[alice,bob]`,
  empty result, shape-only reader), and the FULL runner suite is green — 717 files /
  3533 steps, 0 failed.** Patch: [`S16-stage2-complete.patch`](./S16-stage2-complete.patch).
  Remaining is a design *blessing* for seefeld (Q1–Q5 below), not a blocker.
- **map is genuinely different and correctly identity-only**: it is pointwise /
  length-preserving and has **no** membership taint, so it has nothing to lose by
  not reading elements. The map/filter asymmetry seefeld sensed is real.

## What is verified (instrument-validated, not a structural model)
All on `labs-4367-fu` (#4391 branch); scratch tests written, run, then deleted.

1. **asCell array `.get()` derefs + taints; `getRaw()` does not.** Atomic test
   (plain non-filter container of one labeled link, no predicate/membership
   confound): `asSchema({type:"array",items:{asCell}}).get()` → downstream derived
   label `[alice-secret]`; `getRaw()` → `[]`. Mechanism: `traverse.ts:3473/3486/3489`
   reads the resolved element doc via an ordinary `READ_NON_RECURSIVE_FOR_SCHEDULING`
   (not probe-marked), so it's not excluded at `prepare.ts:1232`.
2. **The leak reaches the persisted result `structure` label, net-new.** Resolving
   the *actual* container (via `keptCell.resolveAsCell()`, NOT the `["kept"]`
   wrapper — the wrapper has no labels, which produced false "label-neutral" nulls
   on first attempt): with an **index-only predicate** (reads index, never element
   content; drops el1) the container `structure` label is still
   `[alice-secret, bob-secret]` — identical to `isPositive`. bob was dropped and
   never read, so the only possible source is the input-list deref.
3. **Porting map's idiom is a security regression.** With the identity-only input
   applied to filter: index-drop structure → `[]` (good) **but** `isPositive`
   structure → `[]` too (membership taint lost), and `cfc-flow-pointwise`
   `filter: shape-only reader…` + `filter: empty result …` FAIL.
4. **The feedback loop.** Unfixed, the coordinator's over-taint smears onto the
   per-element predicate input scaffolding (`index/derived=[alice,bob]`,
   `params/structure=[alice,bob]`), so each predicate result is `[alice,bob]`
   not its own element. The fix breaks the loop → predicate results become precise.
5. **Timing/skip-if-unchanged is why the precise carrier doesn't land.** With the
   fix, a coordinator tx has `J=[alice,bob]` sourced purely from the precise
   predicate-result reads — but it is the pass-2 reconcile whose container value is
   unchanged, so no value write → no `structure` stamp (0 stamps emitted, traced).

## The instrument trap (don't repeat)
`result.key("kept").getAsNormalizedFullLink()` returns the pattern-result wrapper
at `path:["kept"]`, **not** the filter container. Reading its labelMap (or
`getRaw`) shows `[]` and looks like "no over-taint / label-neutral." It is an
artifact. **Always `resolveAsCell()` to the real container** before reading its
persisted labels. The validating control: in `isPositive`, the resolved container
DOES carry `structure=[alice,bob]` (membership taint exists); `getRaw` on the
wrapper shows `[]` regardless. Validate the instrument before trusting a null.

## The fails-without / passes-with shape (with the essential control)
Mirror `cfc-flow-pointwise.test.ts` helpers. Read the **resolved** container's
`origin:"structure"`, `path:[]` confidentiality directly.
- **GUARD (index-drop):** predicate `pattern(({index}) => lift((i)=>i<1)(index))`
  over el0/alice, el1/bob. Resolved container `structure` must NOT contain alice
  or bob (predicate read neither). FAILS today (`[alice,bob]`).
- **CONTROL (isPositive) — REQUIRED:** predicate reads element; el1 negative
  (dropped). Resolved container `structure` MUST still contain `[alice,bob]`
  (legitimate membership). A correct fix keeps this green; the naive fix turns it
  red. Without this control you'll "fix" the guard by deleting confidentiality.

## Implementation attempt (2026-06-29) — Stage 1 works; Stage 2 is the design call
Goal: `structure` taint = **selection criteria** (what the predicate read), not
**all member content**. We attempted the full fix. Findings:

### Stage 1 — identity-only input + slot-write structure re-stamp (BUILT, works)
Patch: [`S16-stage1-prototype.patch`](./S16-stage1-prototype.patch) (apply on
`gideon/4367-followups`: `git apply`). Two changes:
1. **filter.ts:** replace `inputsCell.asSchema(FILTER_INPUT_SCHEMA).get()` with
   map's identity-only materialization (read `op` alone; build element cells from
   raw slot links via `getRaw()` + `resolveLink` under the probe). Removes the
   over-taint AND breaks the feedback loop, so predicate results become **precise**
   (`-XmCmfmA=[alice]`, `eMqIGtpI=[bob]`, traced — not `[alice,bob]`).
2. **prepare.ts:** in the structure-stamp block, a pure-link **slot** link write
   (`["0"]`, etc.) means the parent container's membership changed THIS tx → also
   stamp the parent container's `structure` with J. (Per-element VALUE updates
   rewrite the result cell, not the slot link, so map's no-smear is preserved.)

**Results (with Stage 1):**
- `isPositive` container → `structure[]=[alice,bob]`, `["0"]/link=[alice]` ✓ (over-taint
  gone, membership taint correct and now sourced from predicate results).
- index-drop (predicate reads only index) → `structure[]` carries neither ✓ (no over-taint).
- **Regression sweep: 64 CFC + list-builtin files, 322 steps pass; map no-smear
  preserved; the two tests the naive fix broke now pass.** Only **1** test fails:
  `filter: empty result still carries membership taint on its shape`.

### Stage 1's two gaps (the same root cause)
1. **Empty result (the failing test):** predicate drops EVERY element → result `[]`,
   **no slots** → nothing for the slot hook to catch; and the `[]` value is unchanged
   between the J=`[]` pass (predicates not ready) and the J=`[alice,bob]` pass, so
   `skip-if-unchanged` elides the write → no structure stamp. So `structure[]` stays
   empty. (Today this passes only because the input leak injects the taint on pass 1.)
2. **Timing fragility (structural, not separately reproduced):** Stage 1 re-stamps
   only on a slot write. If el0's predicate settles first (slot `["0"]` written,
   J=`[alice]`) and el1's settles later (J=`[alice,bob]` but slot set unchanged →
   no write → no re-stamp), `structure` could end `[alice]`, missing bob. In our
   in-process test both predicates were ready at the slot-writing pass, so it worked;
   under async load the split is possible. Same root cause as the empty case.

**Root cause (fully traced):** the `structure[]` stamp fires only when the container
**root** is *value-written*, which happens only on the first (empty/provisional)
reconcile — before per-element predicates are ready (J=`[]`). Incremental membership
changes are slot link writes (Stage 1 hooks these) or value no-ops (empty case —
elided). The membership taint (predicate-result reads) is only available on a later
pass, with no root write to ride.

### Stage 2 — value-independent structure re-stamp (BUILT; complete; 717/3533 green)
Patch: [`S16-stage2-complete.patch`](./S16-stage2-complete.patch) (6 files, +149/−4;
supersedes the Stage-1 prototype — it does NOT use the slot-write hook). Rule:
**filter/flatMap re-derive their result container's `structure` from the per-tx J
every reconcile, decoupled from value writes.** Implementation:
- **`cfc/types.ts`:** `CfcTxState.structureContainers: CfcAddress[]`.
- **`storage/interface.ts` + `extended-storage-transaction.ts`:** new
  `recordCfcStructureContainer(address)` (mirrors `recordCfcDereferenceTrace`:
  deep-frozen, invalidates a prepared digest, reset on abort, delegated by the wrapper).
- **`builtins/filter.ts` / `flatmap.ts`:** identity-only input materialization +
  `tx.recordCfcStructureContainer(result.getAsNormalizedFullLink())` each reconcile.
- **`cfc/prepare.ts`:** when `flowPersist && flowHasLabels`, add declared containers
  to `targetKeys`; in the stamp block, **drop the carried-forward `structure` entry at
  the exact container path (preserving per-slot `link[i]`) and re-stamp `structure[]=J`.**
- **Two correctness choices baked in (flag for review):**
  - **Fail-safe on transient empty J:** the re-stamp only runs when `flowHasLabels`
    (J non-empty), so a resume/loading reconcile with not-yet-ready predicates does
    NOT clear a correct prior `structure` label. Consequence: it is **grow/replace on
    non-empty J only** — it won't actively *clear* a stale structure when the secret
    truly goes away until a later non-empty-J recompute (S16 §6 "no retroactive
    relabel; self-corrects" — same posture as `derived`).
  - **Exact-path replace** for the structure entry (not the prefix-based carry-forward
    clear, which would wipe `link[i]`).

### Verification
- `cfc-flow-pointwise.test.ts`: all 4 (map no-smear; filter membership; shape-only
  reader; **empty result**) green.
- Over-taint removed (my guard): index-drop predicate → `structure=[]`; isPositive →
  `structure=[alice,bob]`.
- **Full runner suite: 717 files / 3533 steps, 0 failed.**

### Residual questions for seefeld (design blessing, not blockers)
- **Q1 (answered by impl, confirm):** "structure = selection-criteria J, re-derived
  every reconcile" — adopted. OK as the model, or prefer accepting the conservative
  over-taint as fail-safe? (The fix is opt-in per-builtin, so reversible.)
- **Q2 (churn):** every filter/flatMap reconcile now does a labelMap diff for the
  container even on value no-ops; skip-if-unchanged means **no write when J is stable**
  (verified — no storage churn in the suite). Acceptable, or gate on "predicate-read
  set changed"?
- **Q3 (map):** opted OUT (map doesn't declare; stays clean). Confirm map should never
  carry membership `structure` (it's length-preserving).
- **Q4 (clearing semantics):** the fail-safe "only re-stamp on non-empty J" means a
  structure label can stay stale-high after the secret leaves until the next
  non-empty-J recompute. Is the `derived`-style "self-corrects on recompute" posture
  right here, or do you want active clearing (with resume-flicker guards)?
- **Q5 (order/offset, §8.5.6.1):** filter keep/drop is covered; a pure reorder
  (same key-set) changes order but writes no slot links — does it need its own
  re-stamp, and does J capture the comparator's reads? (Matters for sort-like; out of
  scope for filter/flatMap.)

## #4391 — recommendation (dependency VERIFIED — it IS part of the complete fix)
There are **two** coordinator deref paths that over-taint the result `structure`:
1. the **input-list read** — Stage 2 fixes (identity-only materialization);
2. the **container / own-output read** — `resultWithLog.get()` (`priorSlots`) on the
   `asCell` presence schema, which **#4391 (`7d3366272`) probe-scopes**.

**Verified they are complementary (the decisive grow test):** index-keep-first
predicate (never reads element content) over `[el0, el1]`, settle (`structure=[]`),
then GROW the list to `[el0, el1, el2]` so the re-reconcile reads the *non-empty*
durable container `[el0]` via `priorSlots`:
- **with #4391**: `structure=[]` ✓
- **without #4391** (Stage-2 input fix only): `structure=["alice-secret"]` — the
  container read re-leaked the KEPT element's content.

So **#4391's container probe-scoping is load-bearing** for the COMPLETE fix — it was
"label-neutral" only because the input read was leaking everything anyway; once Stage 2
fixes the input read, #4391 becomes the last guard on the container-read path. (My
earlier "not load-bearing" note was from an incomplete test — index-drop reads an
*empty* prior container, so it never exercised `priorSlots`-deref. The grow scenario
forces the non-empty prior read. Lesson: test the re-reconcile / non-empty-prior path.)

**Net:** the complete over-taint fix = **#4391 (container reads) + Stage 2 (input read
+ structure re-stamp)**. All three #4391 commits keep independent value:
`7d3366272` (container probe-scoping — now load-bearing), `07b1b7793` (trackUntilSettled
doc-nit), `b8b26ca80` (resume-republish unit-mock fix). **Recommendation: fold Stage 2
into #4391** and reframe #4391 from "label-neutral container probe-scoping" to "the
complete S16 filter/flatMap over-taint fix." (Off-main alternative would have to
re-include #4391's container probe-scoping anyway, so folding is cleaner.)

## CT-1801 / SC-8 — recommendation
Hold the CFC specs PR. The canonical spec **is** at
`cf-feat-1/specs/cfc/` (08-05 collection transitions, 08-09 runtime propagation).
§8.5.6.1/§8.5.6.2 articulate member-vs-structure separation and "static reads of
`/items/0` don't join `/items`", but the implementation rule lives only in
`docs/specs/cfc-spec-changes.md` as **SC-7** (coordinator-write taint) + **SC-8**
([normative], not yet canonical: "reading an array whose items resolve to
references without dereferencing consumes container enumeration + per-item shape
only — not element value"). **SC-8 as written is correct for map but would break
filter/flatMap if applied to their coordinators.** Reframe CT-1801 from "formalize
the structure-only-read rule" to "structure taint = selection criteria, not member
content; and the membership-taint carrier (predicate results) must land despite
two-pass timing." seefeld's call.

## Spec grounding (canonical, `cf-feat-1/specs/cfc/`)
- `08-05-collection-transitions.md` §8.5.4.2: filter/flatMap are "element-local
  but prefix-sensitive"; structure dims = membership/domain, order/offset,
  multiplicity. §8.5.6.1: member confidentiality vs structural confidentiality are
  **separate**; the secret-search example (public members, secret predicate) = our
  exact case. §8.5.6.2 + `08-09` line ~118: enumeration consumes parent-path
  observations + each child's shape; static child reads don't join the parent.
- `cfc-s16-default-transition-design.md` D4 + Phase B: the `structure` labelMap
  component (membership) + the pointer/content split; D4 consequence #2 ("audit
  coordinators that materialize values they only pass through") is the map fix.

## Dead ends (don't re-chase)
- **"Port map's identity-only materialization to filter/flatMap"** — security
  regression (see TL;DR / finding 3). This was the prior plan; it is wrong.
- **Reading the result via `getRaw` / the `["kept"]` wrapper to check taint** —
  instrument artifact (see "instrument trap"). Resolve to the container.
- **Per-field labels + subset predicate** (from prior revision) — S7 (no
  descendant aggregation) makes sub-path labels invisible to element-root reads;
  whole-doc labels are required.

## Lesson (carry forward)
Fix-verify caught that the "obvious fix" wasn't a no-op (à la #4391) — it
**broke a security property.** Only the `isPositive` *control* test revealed it;
the guard alone would have passed. Always pair a fails-without guard with a
control that the fix must keep green, and validate the instrument before trusting
a null. (Memory: `validate-fix-observable`, `verify-full-comparison-before-sole-cause`,
`dont-trust-subagent-diagnosis`.)
