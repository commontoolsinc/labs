# iter-4 Full+Browser Eval — Event RSVP (run `2026-06-10-event-rsvp-8adf`)

**Run under test:** `2026-06-10-event-rsvp-8adf` (COMPLETED, score **57 "Functional"**, raw 66, process modifier −9, **4 build iterations** = build + fix_pass_1/2/3).
**Pattern:** `/Users/ben/code/pattern-factory/workspace/2026-06-10-event-rsvp-8adf/pattern/main.tsx` (compiles, **35/35 tests pass**). Byte-identical copy promoted to `/Users/ben/code/pattern-factory/output/event-rsvp/pattern/main.tsx` (verified `diff -q` → IDENTICAL).
**Prior evals:** iter-2 = `489a` (ID1–7 all PASS, but `manual_test` was disabled); iter-3 = `71b6` (first browser run; ID2/ID7 → PARTIAL as a framework-collision casualty; score 69).
**Canonical refs:** `docs/investigations/research/identity-map.md`, `identity-authoring-kit.md`, `docs/common/ai/pattern-critique-guide.md#14`.

> **TL;DR / headline.** The iter-3 verification gap is **CLOSED**: the new critic `$`-binding check fired and caught **all three** `$`-in-`computed()` CRITICALs *statically*, on the first pass, before the browser — exactly the lever iter-3 said was missing. The browser then confirmed **no blank UI** (the static-position fix held). But iter-4 surfaces a *new*, real, browser-manifesting identity defect the rubric does **not** yet catch: the "You" self-label uses **object reference equality** (`myRsvp === rsvp`) on cell-backed objects, which survives unit tests (`.send()`-only) and even the critic's ID6 check (ID6 only forbids *name* equality), but fails across the computed/SES boundary in a real browser. **ID6 and ID7 are the regressions vs iter-2's clean sweep** — not a competence loss, but a gap in the *check*. Plus the run independently discovered a genuine CF gotcha (perSession cells read `undefined` inside onClick handlers) that is currently undocumented for the *handler* case.

---

## 1. ID1–ID7 Scorecard — 8adf final `main.tsx` (vs 489a / 71b6)

| Dim | iter-2 (489a) | iter-3 (71b6) | **iter-4 (8adf final)** | Notes (8adf `main.tsx` file:line) |
|---|---|---|---|---|
| ID1 render others | PASS | PASS | **PASS** | Others via `<cf-avatar src name>` — `main.tsx:859-863` (`rsvpListEntry`), organizer at `:696-700`. No bare-name/`<img>`. |
| ID2 render viewer | PASS | PARTIAL | **PASS** | Viewer resolved via `wish({query:"#profile"})` (`:111`) and rendered with **`cf-profile-badge $profile={profileWish.result}` at a STATIC position** — `:713`, inside the "Your response" card, a direct static child of `<cf-card><cf-vstack><cf-hstack>` (not inside any `{computed(…)}`). **This is the iter-3 fix working: ID2 recovers from PARTIAL → PASS.** No typed-name field. |
| ID3 scope | PASS | PASS | **PASS** | `PerSpace` event/rsvps, `PerUser` myRsvpIndex, draft state plain `Writable` (space-scoped after fix_pass_3). Input types `:55-59`. No stored DIDs/ids. |
| ID4 join + snapshot | PASS | PASS | **PARTIAL (downgrade vs 489a)** | No roster/join mechanism. Each `submitRsvp` snapshots `{displayName, avatar}` from `#profile` into the `rsvps` array (`:222-228`), so **respondents** are snapshotted — but there is **no enrollment roster**, so non-responders can't be enumerated (no "Undecided"). 489a had a true join-by-snapshot roster with a cell-ref `me` pointer; 8adf regressed to index-based RSVP tracking. Snapshot-of-respondent is present; **roster** is absent. (Critic FAIL ID4, `critic-001.md:182`.) |
| ID5 authorship | PASS (in-scope) | PASS (in-scope) | **PASS (in-scope)** | Organizer + respondent = snapshots `{displayName, avatar}` (`:20-23, 199, 222`). CFC correctly out of scope for a casual small-group tool (spec). |
| ID6 identity pitfalls | PASS | PASS | **FAIL (downgrade)** | "Is this me?" is `const isMe = myRsvp === rsvp` — **object reference equality** at `:758, :781, :804`, not `equals()` on a cell reference. The spec + `multi-user-patterns.md` require `equals()`. Works in unit tests (same array instance) but **fails across the `.filter()`/`computed()`/SES boundary in browser** → "You" never shows. **This is a real browser-manifesting defect, not a type-level nit.** (489a used `equals()` on cell refs throughout; 8adf is a genuine regression.) |
| ID7 identity UX | PASS | PARTIAL | **PARTIAL (downgrade vs 489a)** | Avatars throughout + `cf-profile-badge` for the viewer (static, renders) + a "Your response" card with status chip. **But** the self-distinction in the guest list — the "You" label — is **broken in browser** (the ID6 `===` bug; `rsvpListEntry` renders `{isMe ? "You" : displayName}` at `:867`, and `isMe` is always false at render). Browser shows "Guest" where "You" should be (manual-test.md:152-153, 220-222). Self-distinction *intent* present, *mechanism* broken — the same shape as iter-1's PARTIAL, but here it's a reference-equality casualty, not name-equality. |

**Net vs iter-2 (489a, the clean sweep):** ID2 holds (recovered the seal that iter-3 lost), but **ID4 PASS→PARTIAL** (roster dropped), **ID6 PASS→FAIL** (`===` instead of `equals()`), **ID7 PASS→PARTIAL** (the "You" label is the ID6 casualty). **Net vs iter-3:** ID2 PARTIAL→PASS (badge is back, statically placed and rendering); ID6 PASS→FAIL is the headline new defect; ID7 stays PARTIAL but for a *different* reason (iter-3 lost the badge; iter-4 has the badge but a broken in-list "You").

**Why the divergence from 489a's all-PASS.** 489a built a real roster with a cell-reference `me` pointer and compared with `equals()` everywhere (`equals(r.member, member)`), which is what makes ID4/ID6/ID7 robust. 8adf took the *simpler* index-pointer route (`myRsvpIndex: number`) and then, for the in-list "is this me?", reached for `===` on the looked-up object — the exact pitfall the canonical references warn against. The identity *primitives* (badge, avatar, `#profile`) are all correct; the *identity-equality discipline* slipped.

---

## 2. Did the new critic `$`-binding check fire? — **YES. The iter-3 verification gap is CLOSED.**

iter-3's load-bearing recommendation (`iter3-full-eval.md` §9c) was: give the critic a mechanical "`$`-binding inside `computed()`" lever, because the *static* critic had **blessed** `$profile`-in-computed on the broken 71b6 code (it PASSED ID1 on code that blanked the browser). In iter-4 that lever **exists and fired on the first pass**, under a dedicated section.

**`critic-001.md:186-189` — "Bidirectional $-binding placement":**

> - [FAIL] **CRITICAL** Line 361: `$value={draftMessage}` inside `computed(() => draftStatus.get() !== null ? ...)`. Will blank the render when `draftStatus` becomes non-null. Tests will not catch this (`.send()` path only). Fix: hoist the entire form body to a static position, switching with `ifElse`.
> - [FAIL] **CRITICAL** Line 832: `$profile={profileWishInner.result}` inside `rsvpListEntry()` which is invoked inside computed `.map()` callbacks. The `$profile` binding is in a computed subtree. Will blank the render when a going/maybe/notGoing list entry is the viewer's own. Fix: pass `profileWish` from pattern scope as a parameter; ensure `$profile` binding appears in a static VNode.

That is **two of the three** CRITICALs in the dedicated `$`-binding section. The **third** CRITICAL — onClick inside the same computed subtree — is logged under §3 Conditional Rendering and §5 Binding:

> `critic-001.md` §3: [FAIL] **CRITICAL** … a `computed(() => draftStatus.get() !== null ? <cf-vstack>...</cf-vstack> : ...)` block contains onClick event handlers … "onClick or conditional UI inside `computed()` → Move the interactive element outside…"

The Priority Fixes list (`critic-001.md:206-210`) crisply names all three: **P1** (`$value` in computed → blanks UI), **P2** (`$profile` in computed via `rsvpListEntry` → blanks UI), **P3** (onClick in computed). The critic explicitly flags that **".send()-driven tests will not catch this"** — i.e. it understood *why* the static gate must own this, not the test suite.

**Confirmation the gap is closed.** In iter-3 the browser (`manual_test`) was the *only* stage that caught the `$profile`-in-computed blank; the critic missed it. In iter-4 the **critic caught all three `$`-in-computed CRITICALs statically, one full stage earlier than the browser**, and the orchestrator fixed P1/P3 in fix_pass_1 and worked around P2 in fix_pass_2 (`summary.md:64-66, 85-90`). The recommended static lever from iter-3 §9c demonstrably landed and did its job.

---

## 3. Did the browser confirm no blank UI? — **YES. The fix held.**

The mandate of the manual-test phase was to confirm the `$`-binding render bug from iter-3 does not recur. It did not.

**`reviews/manual-test.md:235` (Summary):**

> The critical bidirectional-binding render bugs (the main mandate of this test) are NOT present — no blank screens observed after status selection or guest list updates, and no "Bidirectionally bound property ... is not reactive" console errors were found. The fix held.

Per-check confirmations:
- **`manual-test.md:79`** — *"PASS — Clicking Going/Maybe/Not Going in the initial RSVP form does NOT produce a blank/white screen. No 'Bidirectionally bound property … is not reactive' console errors were observed. The bidirectional binding fix is holding."*
- **`notes/manual-tester.md:190-196`** — blank-screen check across five interaction points (status select, guest-list append, Edit open, Save with status change, Cancel): all *"NO blank screen ✓ … PASS: The bidirectional binding fix is holding."*
- **`notes/manual-tester.md:188`** — *"No 'Bidirectionally bound property' errors found ✓."*

So the static `$`-binding critic catch (§2) plus the fixes produced a browser render with **zero** blank-UI / `$`-binding console errors. The iter-3 defect class is closed both in the *check* and in the *artifact*.

---

## 4. Refinements surfaced (ranked, concrete)

### (a) [HIGHEST] Cat-14 / factory critic ID6 must also fail **object-`===` / reference-equality on cell-backed objects**, not just display-name equality

**Why it slipped.** The "You" bug (`isMe = myRsvp === rsvp`, `main.tsx:758/781/804`) is a *reference-equality* defect, not a *name* comparison. The current rubric only forbids the latter:

- `docs/common/ai/pattern-critique-guide.md:192` — *"identity comparison | dedup or 'is this me?' by **display-name equality** | compare a cell reference with `equals()`, never the mutable name"*.
- `skills/pattern-critic/SKILL.md:22-23` — *"roster dedup / 'is this me?' by **display-name** instead of `equals()` on a cell reference."*

Both phrasings key on "display-name". The maker used `===` on objects (no name in sight), so the critic's ID6 had **nothing to match** and **PASSED it** (`critic-001.md:184` even rationalizes the `===` as "works … but diverges from the platform-idiomatic pattern" → logged as commentary, not a FAIL). Result: a browser-manifesting self-distinction bug shipped with ID6 green. This is the **direct analogue of iter-3's `$`-binding miss**: the check existed for the *named* failure mode but not the *mechanically adjacent* one.

**Proposed exact added wording** — replace the cat-14 "identity comparison" row (`pattern-critique-guide.md:192`) with:

> | identity comparison | "is this me?" / dedup by `===` (object **or** index/reference) equality on a value pulled out of a `Writable<T[]>` via `.get()[i]`, `.find()`, `.filter()`, or `.map()` — **OR** by display-name equality | compare a **stable cell reference** with `equals()` (e.g. `equals(entry.ref, myRef)`), or a stable string **id** (`r.id === myId`). **Object `===` on array elements is a FAIL even when no name is involved**: filtered/computed/SES boundaries re-materialize the object, so `===` silently returns false in the browser while passing `.send()`-only unit tests. |

And append a sentence to the cat-14 severity note (`:195`):

> A "is this me?" check built on object reference equality (`a === b` where `a`/`b` are elements of a reactive array) is **MAJOR** — it manifests only in the browser (self-label/"You" never lights up) and is invisible to unit tests; the static check must flag it on the `===` token, not wait for the name.

Mirror the same into `skills/pattern-critic/SKILL.md:20-25` (add "…or by **object/index reference equality** (`myRsvp === rsvp`) on elements pulled from a reactive array — use `equals()` on a cell ref or a stable string id"). This is grep-able statically (look for `=== ` between two locals that originate from `.get()`/`.filter()`/`.map()` over a `Writable[]`), so it costs no deploy and catches the defect a full stage before the browser — exactly the iter-3 §9c playbook applied to identity-equality.

### (b) [HIGH] Document the **PerSession-vs-onClick runtime constraint** (perSession cells read `undefined` inside onClick handler closures)

**The discovery (real CF gotcha).** `summary.md:111-119` + `manual-test.md:253-261`: draft state declared as `new Writable.perSession()` caused `createEvent`/`submitRsvp` to receive `undefined` — root cause: *"`Writable.perSession()` cells cannot be read or written from onClick arrow function handlers… handlers receive session-scoped cells as read-only… reading perSession cells from within handler closures returns `undefined` because the session scope hasn't synchronized when the handler runs."* Fix applied: revert draft cells to plain `new Writable()` (space scope) so onClick can read/write; the documented production-correct fix is to wrap the onClick body in an explicit `action()` (`summary.md:118, 261, 287`).

**Why existing docs don't cover it.** The repo already documents two *adjacent* perSession pitfalls, but **neither covers the onClick-handler-read case**:
- `gotchas/scoped-cell-pitfalls.md` §4/§5 — perSession `.get()` returns `undefined` until first sync **in render-path computeds** (guard with `?? []`). That's the *render* path, not a handler closure.
- `gotchas/persession-read-in-mapped-computed.md` — a *nested computed* in a mapped list can't follow a perSession cell; and it explicitly says (`:76`) *"Setting the perSession cell from an `onClick`/action is **not** affected"* — i.e. it disclaims exactly the case 8adf hit (a perSession cell **read** from inside the onClick closure that the CTS transformer lifts into a `handler()` whose perSession dep arrives read-only/unsynced).
- `gotchas/onclick-inside-computed.md` — the ReadOnlyAddressError for onClick *inside computed()*; a different failure (write-to-read-only-address), not "perSession reads undefined in a handler".

**Where to document (do all three):**
1. **New gotcha doc** `docs/development/debugging/gotchas/persession-read-in-onclick-handler.md` — symptom: *"action receives `undefined`; `Cannot destructure property 'title' of 'undefined'`; a perSession `draft.get()` inside an `onClick={() => action.send({ x: draft.get() })}` reads `undefined`."* Cause: the CTS transformer lifts the arrow into a `handler()` whose perSession dependency is provided **read-only and unsynced** at handler-execution time. Fix: (i) use a plain space-scoped `Writable` for form drafts that onClick must read; **or** (ii) wrap the onClick body in an explicit `action()` (the multi-user-correct fix — it can safely read/write any scope); **or** (iii) pass the value through the event rather than reading the cell in the closure. Add a README.md table row next to the other two perSession rows (`debugging/README.md` ~:18/:36).
2. **`pattern-dev` skill** — one line under draft-state guidance: *"perSession draft cells are read-only/undefined inside onClick handler closures; prefer a plain `Writable` for onClick-read drafts, or wrap the onClick in `action()`."* (The skill already steers draft-state scoping; this is the missing caveat.)
3. **A critic check** (Cat 7 Handler Binding, or Cat 2 Reactivity) — *"FAIL/NOTE if a `Writable.perSession()` cell is `.get()`-read inside an `onClick`/inline-arrow handler — it reads `undefined` at handler time; use a plain `Writable` or an explicit `action()`."* Grep-able: a `perSession` cell name appearing inside an `onClick={() => …}` body.

### (c) [MEDIUM] The docs caveat is **insufficient to prevent the maker writing `$`-in-computed upfront** — add a stronger maker-side guard

**Evidence it's insufficient.** This is the **fifth** `$`-binding-in-`computed()` blank-UI bug across four factory iterations (iter-3's `71b6` hit it; our PR'd exemplar latently has it per `iter3-full-eval.md` §3; iter-4 `8adf` hit it **twice** — `$value` at the message input and `$profile` via `rsvpListEntry`). The maker reliably writes the bug, then the critic (now) catches it, then a fix pass restructures. The cost is iterations: 8adf burned fix_pass_1 (P1/P3) and fix_pass_2 (P2 workaround) on this class alone (−6 of the −9 process modifier traces to it). The critic-side catch (§2) is working **reactively**; the *maker* still produces the defect because its guidance is silent on it. Confirmed: `docs/common/ai/pattern-factory-build-guide.md` has **zero** mentions of `$`-bindings, static-position, "not reactive", `ifElse`-as-child, or VNode placement (grep returns nothing across all 187 lines) — the build guide never tells the maker the rule.

**Proposed stronger maker-side guard** — add an explicit, worked example to the **build guide** (the maker's primary reference), not just a docs caveat the maker may not consult. Suggested insert under a new "Bidirectional bindings must be statically placed" heading:

> **Every `$`-bound control (`$value`, `$checked`, `$profile`, `$center`, …) must sit at a STATIC `[UI]` position — never inside a `{computed(() => …)}` subtree, and never inside a helper called from `.map()` inside a `computed()`.** Inside a computed the cell is auto-unwrapped to its plain value before `h()` runs, and the renderer throws *"Bidirectionally bound property … is not reactive"*, blanking the **entire** pattern. This is invisible to `.send()`-driven tests (they never render `[UI]`).
>
> ```tsx
> // WRONG — $value regenerated inside computed → blanks the whole render
> {computed(() => draftStatus.get() ? <cf-input $value={draftMessage} /> : null)}
>
> // RIGHT — two fully-static branches, switch with ifElse; $value lives in a static branch
> const expanded = <cf-vstack>…<cf-input $value={draftMessage} />…</cf-vstack>; // static
> const hint     = <cf-vstack>…</cf-vstack>;                                    // static
> ifElse(computed(() => draftStatus.get() !== null), expanded, hint)
> ```
>
> Gate only *siblings* of a `$`-bound control reactively, or lift it into its own `pattern<{value}>(…)` sub-pattern if it must live behind a condition. Cross-ref `packages/patterns/scope-bug-computed-vnode-blank/main.tsx`.

Also surface the same worked example in the **`pattern-dev` skill** (which the maker loads) — a single canonical before/after is far stickier than a prose caveat. (The repo-memory note "`[UI]` must be a static VNode… use `ifElse` as a *child* of a static wrapper" is the same rule; the build guide and pattern-dev skill should carry the concrete `$`-binding instance of it.) This converts the lesson from "critic catches it on pass 1, fix pass restructures" (current: costs 1–2 iterations every run) to "maker avoids it upfront" (saves the process modifier).

---

## 5. HANDOFF — deploy info (open the already-deployed pattern; or re-deploy fresh)

**Dev servers (keep running — do NOT kill):** Toolshed/API `http://localhost:8100`, Shell `http://localhost:5273` (`notes/manual-tester.md:13-15`).

### Open the pattern the manual-tester already deployed (fastest)

The browser-tested piece **after the fix passes** (`manual-test.md:250`, gates: check exit 0, 35/35 tests):

```
Piece ID (final, fixed):  fid1:KmBPWxxoCtn4ymYSHsIwoLVqN4luLNccYyVIhPtmC2o
Space:                    factory-test
API URL:                  http://localhost:8100
```

**Open in a browser** (URL form is `http://<api>/<space>/<pieceId>`, per `notes/manual-tester.md:82`):

```
http://localhost:8100/factory-test/fid1:KmBPWxxoCtn4ymYSHsIwoLVqN4luLNccYyVIhPtmC2o
```

(Earlier pre-fix pieces, for reference only — these still have the HIGH onClick/oncf-input bugs: browser `fid1:MG1Jhw2ViCtzejKWTs-SXnW8J4iQznYnTb14_Tbvjm0`, CLI `fid1:iftZ3imP84Vu13sKq4_2Gwse1zfb08fCBWZyCqWOJw0` — `manual-test.md:3-4`.) Log in via the shell's **Import CLI Key** with `/Users/ben/code/labs/claude.key` (`notes/manual-tester.md:84-86`).

### Re-deploy `output/event-rsvp/pattern/main.tsx` fresh

The promoted artifact (`/Users/ben/code/pattern-factory/output/event-rsvp/pattern/main.tsx`) is byte-identical to the 8adf final. The task referenced `deno task ct piece new …`; the canonical labs/cf task is **`deno task cf piece new`** (`skills/cf/SKILL.md:87,173`; `skills/pattern-deploy/SKILL.md:34`). Run from `~/code/pattern-factory` (so the relative `../labs/claude.key` resolves):

```bash
# from /Users/ben/code/pattern-factory  (long-flag form)
deno task cf piece new output/event-rsvp/pattern/main.tsx \
  --identity ../labs/claude.key \
  --api-url http://localhost:8100 \
  --space factory-test

# equivalent short-flag form (identical semantics)
deno task cf piece new output/event-rsvp/pattern/main.tsx \
  -i ../labs/claude.key -a http://localhost:8100 -s factory-test
```

The command prints a fresh `fid1:…` piece id; open it at `http://localhost:8100/factory-test/<that-id>`. (If `deno task ct` is the alias wired in `pattern-factory`'s own `deno.json`, substitute `ct` for `cf` — both map to the same CLI; the flags are unchanged.) Use `--space <name>` to deploy into a clean space if you want a fresh first-run state.

> **What to expect in the browser (8adf behavior):** create-event / submit-RSVP / edit / live headcount / status grouping all work; **no blank screens**. The two known LOW defects remain visible: (1) status toggle buttons don't visually highlight on click (LOW-2, `variant` computed doesn't re-render), and (2) your own guest-list entry shows your name ("Guest") instead of **"You"** (LOW-3 — the §4a `===` bug). The "Undecided" section is absent by design (no roster).

---

## 6. VERDICT — are the pieces in place for the factory to do a good job on multi-user identity?

**Mostly.** The factory's identity machinery is now genuinely four-stage and two of its three known failure modes are sealed: the spec-interpreter pre-decides identity, the maker uses the right primitives (`#profile` wish, `cf-profile-badge` for self, `cf-avatar` for others), the **critic's new `$`-binding lever caught all three `$`-in-`computed()` CRITICALs statically** (closing the exact iter-3 verification gap where the browser was the sole catch), and the browser confirmed **no blank UI** — so the render-blocking class that crippled iter-3 is closed in both the check and the artifact, and ID2 recovered its trusted-badge PASS. **But** iter-4 exposes the *next* layer: the identity-**equality** discipline is not yet enforced. The "You" self-label was built on object `===` rather than `equals()`/stable-id, which passes unit tests and even passes the critic's ID6 (because ID6 only forbids *name* equality, not reference equality) yet fails in the real browser — a defect mechanically identical to iter-3's gap, one level up. So ID6/ID7 regressed from iter-2's clean sweep not through lost competence but through an unchecked failure mode, and ID4 regressed because the simpler index-pointer route skipped the roster. The fixes are precise and cheap (refinement 4a closes the equality gap statically on the `===` token; 4b documents the perSession-onClick gotcha the run discovered; 4c moves the `$`-binding lesson maker-side to stop paying it in iterations) — none requires new infrastructure, only sharpening checks the pipeline already has. With 4a landed, the factory would be in good shape for multi-user identity; without it, it will keep shipping browser-broken self-distinction behind green tests and a green ID6.
