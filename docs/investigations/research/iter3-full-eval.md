# iter-3 Full+Browser Eval — Event RSVP (run `2026-06-08-event-rsvp-71b6`)

**Run under test:** `2026-06-08-event-rsvp-71b6` (COMPLETED, score **69 "Functional"**, raw 74, process modifier −5, 3 build iterations).
**First run with the `manual_test` phase** (deploy + agent-browser). It caught a HIGH defect every static pass (build + 2 critic passes + 40 green tests) missed.
**Prior evals:** iter-1 = `90bc` (anti-pattern; ID 1/PASS), iter-2 = `489a` (ID 7/PASS, but manual_test disabled).

> **TL;DR / headline:** The browser run did its job — it caught a render-blocking defect (`$profile` inside `computed()` → blank UI) that 40 passing `.send()`-driven tests and two critic passes blessed. **The most important finding: OUR PR'd exemplar `packages/patterns/event-rsvp/main.tsx` has the SAME bug** — its two `<cf-profile-badge $profile=…>` sites (lines **418** and **457**) are BOTH inside `computed()` subtrees, so it would render **blank in a browser**. Its tests pass only because they `.send()` and never render. The shipped gold exemplar `fair-share` does NOT have the bug (badge at a **static** position, line 264). The docs (`COMPONENTS.md`, `multi-user-patterns.md`) show the badge but **never warn** it must be static, so a maker following them literally in a computed-heavy pattern hits the blank-UI bug — which is exactly what 71b6 did.

---

## 1. THE CRITICAL QUESTION — what broke, and the real rule

### 1a. What exactly broke (71b6), quoted

`reviews/manual-test.md:114-141` (DEFECT-1, HIGH):

> **Location:** `main.tsx` line 426, inside `const myRsvpSection = computed(() => { ... })`:
> `<cf-profile-badge $profile={profileWish.result} size="sm" />`
> **Error thrown:** `Error: Bidirectionally bound property $profile is not reactive / If invoking from within computed(), consider moving the component into a pattern`
> **Impact:** The entire pattern UI fails to render in the browser. Both the creation-form state and the event-view state produce a blank content area.

The error fires on **every settle cycle** because `myRsvpSection` is a top-level `computed()` evaluated eagerly — so the blank happens regardless of which branch would show (`manual-test.md:24-26`).

**Before → after in 71b6** (`notes/pattern-maker.md`, "Fix Pass 2"):
- **Before** (`pattern/main.tsx` at critic time): `myRsvpSection` computed contained `<cf-profile-badge $profile={profileWish.result} size="sm" />`.
- **After** (`pattern/main.tsx:415-434`): replaced with `<cf-avatar src={viewerAvatar} name={viewerName || "You"} size="sm" />` using string snapshots from `profileNameWish`/`profileAvatarWish`; `profileWish` deleted. Documented as a spec deviation at `main.tsx:176-181, 418-423`.

### 1b. The REAL rule (verified against framework source)

The rule is **NOT** "`cf-profile-badge` is unusable in patterns" and **NOT** specific to `$profile`. The guard is in `packages/html/src/h.ts:72-92`:

```
Object.keys(props).filter((key) => key.startsWith("$")).forEach((key) => {
  const value = props![key];
  if (typeof value !== "object") { throw "Bidirectionally bound property ${key} is not reactive ..." }
  else if (!isCell(value) && !isCellResult(value)) { throw ... }
  props![key] = bindingTargetLink(value);
});
```

`h()` throws for **any** `$`-prefixed prop whose value, *at the moment `h()` runs*, is not a live cell / cell-result. The deciding factor is **where `h()` executes**:

- **Static position** (the `$`-binding's `h()` call runs once, at pattern-build time, outside any `computed()` body): the cell / `wish.result` is passed through as a **live cell object** → `isCell`/`isCellResult` true → **passes**. ✅
- **Inside a `computed()` subtree** (the `h()` call runs inside the computed body on every settle): the CTS transformer/runtime has already **auto-unwrapped** the cell to its plain VALUE (a string / plain object) before `h()` sees it → `isCell` false → **throws**, blanking the whole render. ❌

This is confirmed by the labs repro pattern **`packages/patterns/scope-bug-computed-vnode-blank/main.tsx`** (header W4): *"`<cf-input $value=>` inside `{computed(() => <div/>)}` — produces a runtime error 'Bidirectionally bound property $value is not reactive'."* So the rule is the same one repo-memory states — **`[UI]` must be a static VNode; a `$`-binding must sit at a static position, not be regenerated inside a reactive computed.** It applies to `$value`, `$checked`, `$profile`, `$center`, every `$`-prop.

**Operationally:** the manual-tester's phrasing ("`$`-bindings are illegal inside `computed()`") is the correct, actionable rule. `cf-profile-badge` works fine at a static position (see §2); it only blanks when regenerated inside a computed.

---

## 2. Does fair-share render `cf-profile-badge` successfully, and HOW? — YES, statically

`packages/patterns/fair-share/main.tsx:264`:
```tsx
<cf-profile-badge $profile={profileWish.result} size="sm" />
```
This sits at a **STATIC position**: `[UI]` opens at line 247 (`<cf-vstack>…`), and the badge is a direct static child of `<cf-card> → <cf-vstack> → <cf-hstack>` (the "You are" row, lines 256-264). It is **not** inside any `{computed(() => …)}` wrapper — the nearest computed (line 268) is on a *sibling* `disabled=` prop, not wrapping the badge. fair-share's `.map()` lists and conditionals are computed, but the badge itself is hoisted to the static tree. **This is the correct pattern: resolve the wish once, drop the badge at a fixed [UI] position, gate only siblings reactively.**

(Cross-check: 489a (iter-2) also placed its badges statically — `[UI]` at `489a/pattern/main.tsx:525` opens `(<cf-screen>`, badge at line 632 is in a static `<cf-card><cf-vstack>` chain, not a `{computed(…)}`. That's why 489a's tests didn't surface it — but 489a had **no** browser test either, so it was never rendered. 71b6 is the first time the factory actually rendered a generated pattern.)

---

## 3. ⚠️ DOES OUR EXEMPLAR HAVE THE BUG? — **YES. DEFINITIVE: browser-broken.**

`packages/patterns/event-rsvp/main.tsx` builds its **entire** `[UI]` from computed subtrees and places **both** `cf-profile-badge` sites inside them:

- `[UI]` opens at **line 344** (`<cf-vstack>`). Its first child is **`{computed(() => eventCreated ? (…) : (…))}` at line 347**.
- **Badge site #1 — line 418-421** ("Hosting as", in the create-form / `:` false-branch of the line-347 computed):
  ```tsx
  <cf-profile-badge $profile={profileWish.result} size="sm" />
  ```
  → inside `computed()` ⇒ **throws `$profile is not reactive` ⇒ blank.**
- **Badge site #2 — line 457-460** ("You are", inside `{computed(() => eventCreated ? (…) : null)}` at line 446):
  ```tsx
  <cf-profile-badge $profile={profileWish.result} size="sm" />
  ```
  → inside `computed()` ⇒ **throws ⇒ blank.**

`profileWish` is declared at line 281; both bindings reference `profileWish.result` from inside computed bodies.

**Verdict: our exemplar would render a completely BLANK UI in a browser, identical to 71b6 DEFECT-1.** The first `$`-binding to evaluate during settle blanks the whole render.

**It is actually worse than just the badge.** The same `h()` guard hits **every** `$`-binding regenerated in a computed. Our create-form `cf-input`s are also inside the line-347 computed:
- `$value={titleDraft}` (line 392), `$value={dateTimeDraft}` (398), `$value={locationDraft}` (404) — all inside computed ⇒ would throw.
- `$value={messageDraft}` (line 533) — inside the line-446 computed ⇒ would throw.

So even if the badges were swapped to `cf-avatar`, the create form and the note field would **still** blank. The whole top-level structure (`{computed(() => …)}` blocks as direct `[UI]` children, each containing `$`-bound controls) is the anti-pattern.

**Why our tests don't catch it:** `main.test.tsx` drives every handler via `subject.createEvent.send(…)` / `setRsvp.send(…)` and asserts on `.get()` of shared cells (see the test header, lines 1-20). It **never renders `[UI]`**, so the `h()` guard never runs. 40/40 green is fully consistent with a 100%-blank browser render. This is the exact failure mode iter2-eval.md:187 predicted (quoted in §8).

---

## 4. Do our DOCS mislead? — **YES. They show the badge with no static-position caveat.**

Both docs present `<cf-profile-badge $profile={profileWish.result} size="sm" />` and **never** mention that it (or any `$`-binding) must be at a static position / must not be regenerated inside `computed()`:

- **`docs/common/components/COMPONENTS.md:848-867`** ("cf-profile-badge"): shows the example at line 857; lists caveats about the verified seal and cross-space limits — but a `grep` for `not reactive | inside computed | static position | bidirection`-warning returns **nothing**. The example is a bare top-level snippet (implicitly static, but unlabeled).
- **`docs/common/patterns/multi-user-patterns.md:204-288`** ("Presenting Identity"): the "Show the viewer" snippet (line 230-236) shows the badge at line 232; the "Constraints to design within (today)" list (266-273) covers CT-1665/CT-1667 but **not** the computed() restriction. `grep` confirms **zero** mention of the rule in this file.

**Would a maker following them literally hit the blank-UI bug?** **Yes** — and 71b6 is the proof. The spec demanded *"The viewer is rendered with cf-profile-badge"* (`71b6/spec.md:32, 68`), the UX-design demanded the viewer's badge live in the "My RSVP" section assembled as a `computed()` subtree (`ux-design.md:67, 115`), and `multi-user-patterns.md` is exactly the doc the maker cited (`notes/pattern-maker.md` "Docs Consulted"). The maker copied the literal snippet into a computed and blanked the UI. **The docs encode the *what* (use the badge) but not the *where* (static position only).**

**Exact caveat the docs should add** (both files, at the badge usage):

> ⚠️ **`$profile` (like every `$`-bidirectional binding) must be at a STATIC position in the `[UI]` tree.** Resolve `wish({query:"#profile"})` once and place `<cf-profile-badge $profile={…}/>` directly in the static JSX. Do **not** put it inside a `{computed(() => …)}` subtree — inside a computed the cell is auto-unwrapped to a plain value and the renderer throws *"Bidirectionally bound property $profile is not reactive"*, blanking the entire pattern. Gate only *siblings* of the badge reactively (e.g. a `disabled=` prop or an adjacent conditional), or lift the badge into its own `pattern<{profile}>(…)` sub-pattern and render `<Badge {profile}/>` if it must live behind a condition. Same rule for `$value`, `$checked`, etc.

(`COMPONENTS.md:428-431` already shows the "view-switch via `computed()`" idiom for *content*; it just needs the explicit "but `$`-bound controls must stay static" qualifier, ideally with a pointer to `scope-bug-computed-vnode-blank`.)

---

## 5. ID1–ID7 Scorecard — 71b6 final `main.tsx` (vs 489a / iter-1)

| Dim | iter-1 (90bc) | iter-2 (489a) | **iter-3 (71b6 final)** | Notes (71b6 file:line) |
|---|---|---|---|---|
| ID1 render others | FAIL | PASS | **PASS** | Others via `<cf-avatar src name>` — `main.tsx:514, 545, 576`. |
| ID2 render viewer | FAIL | PASS | **PARTIAL (downgrade)** | Viewer **resolved** via `#profileName`/`#profileAvatar` wishes (`:180-181`) but rendered with **`cf-avatar`, not `cf-profile-badge`** — no verified seal (`:434`). Identity is right; *trusted medium* lost. |
| ID3 scope | PASS | PASS | **PASS** | `PerSpace` event/roster, `PerUser` myRsvp, `PerSession` drafts (`:75-89`). |
| ID4 join + snapshot | FAIL | PASS | **PASS** | Each submit snapshots `{displayName,avatar}` into roster (`:227-232, 242-247`). |
| ID5 authorship | FAIL | PASS (in-scope) | **PASS (in-scope)** | Organizer + attendee = snapshots; CFC out of scope per spec (`spec.md:74`). |
| ID6 pitfalls | FAIL | PASS | **PASS** | Was MAJOR (index pointer) in Pass 1; fixed to stable UUID `r.id===myId` (`:55-57, 235`). Not `equals()`-on-ref, but UUID is the platform-idiomatic alternative for elements inside `Writable<RSVP[]>` (critic-002:137-138). |
| ID7 identity UX | PARTIAL | PASS | **PARTIAL (downgrade)** | Avatars throughout + strong self-distinction ("Your response" card, left-border). But viewer lacks the badge/seal; DEFECT-3 hides the viewer's own status group when sole member. |

**Net:** iter-3 regresses ID2 (PASS→PARTIAL) and ID7 (PASS→PARTIAL) vs iter-2 — **not** a competence regression but a **framework-collision casualty**: to escape the blank-UI bug the factory had to drop `cf-profile-badge` for the viewer. **ID2 is PARTIAL, not FAIL** — viewer identity is still correctly profile-resolved (no typed-name field) and rendered with a real identity component (`cf-avatar`); only the trusted seal is missing. Calling it FAIL would overstate it; the dead-string anti-pattern (iter-1) is fully avoided.

---

## 6. Did the critic Identity category fire? Did the grade score identity? — YES to both

**Critic Cat 14 "Identity and Authorship (multi-user)" fired** with explicit per-ID verdicts. `reviews/critic-002.md:130-138`:

> - [PASS — ID1] Viewer rendered with `cf-profile-badge` (line 426). All other attendees rendered with `cf-avatar`…
> - [PASS — ID2] Viewer resolved via `wish({ query: "#profile" })`…
> - [PASS — ID6] The numeric-index RSVP pointer is now replaced with a stable string UUID… (Was MAJOR FAIL in Pass 1 — now resolved.)

**⚠️ Critic blind spot:** Cat 14 ID1 PASSED *because the critic reviewed the `pattern/` snapshot where the badge was still `cf-profile-badge` at line 426* — and the critic is **static**, so it blessed the `$profile`-in-computed placement as correct. The critic has an identity lever but **no "is this `$`-binding inside a computed()?" lever** — the very thing manual_test caught.

**Grade scored identity explicitly** in three places (`score.json` + `notes/grader.md`):
- **SPF-2 (−10):** *"the final implementation uses cf-avatar for the viewer due to the framework's prohibition on bidirectional $-bindings inside computed(). … the cf-profile-badge (with its verified-identity badge) is absent."* (`score.json:84-87`)
- **UXD-9 (−5):** *"Viewer rendered with cf-avatar instead of cf-profile-badge — the verified identity badge is absent. UXD-9 partially fails…"* (`score.json:109`; reasoning `grader.md:265-269`)
- **CCR-12 PASS (post-fix):** UUID identity acknowledged correct (`grader.md:138-141`).

So the identity rubric (CCR-12 / SPF-2 / UXD-9) is wired and firing.

---

## 7. Transfer-test integrity — clean (no held-out-exemplar leak)

`grep` for `packages/patterns/event-rsvp` (the held-out exemplar) across `71b6/spec.md`, `ux-design.md`, `brief.md`, `notes/` → **zero hits**. The held-out labs `event-rsvp` is NOT leaked.

The only exemplar references are to **`fair-share/`** (the deliberately-provided *gold* exemplar) and `scoped-group-chat`/`scoped-user-directory` (`spec.md:10`, `notes/spec-interpreter.md:18, 78`). This is by design — fair-share is the teaching reference; event-rsvp is the held-out target being rebuilt. **No integrity violation.**

---

## 8. New factory-infra findings

1. **manual_test phase WORKS and is high-leverage.** First run with deploy+browser caught a HIGH defect that build + 2 critic passes + 40 green tests all missed. This *exactly* fulfills iter2-eval.md:187's recommendation:
   > "tests that drive handlers via `.send()` are blind to UI-layer breakage (button-in-`computed`)… Consider a lightweight render/click smoke check, especially since Phase-4 manual testing was disabled for this run."
   The smoke phase landed and immediately paid off. Re-test pass (`manual-test-2.md`) confirmed the fix and all 8 target criteria PASS (with 3 LOW defects).
2. **pattern-maker did NOT register a "pattern-maker" tool/agent issue** — `notes/pattern-maker.md` is substantive (docs consulted, design decisions, 2 build iterations, 2 fix passes). No registration failure this run. (Maker even cited `identity-authoring-kit.md` noting *"cf-profile-badge placement in static JSX (not inside computed())"* in fix-pass 2 — the factory's own kit had the rule right; the public docs did not.)
3. **index-identity MAJOR caught by critic Pass 1** (`critic-001.md:120-122, 217`): *"'Is this my RSVP?' is determined by a numeric index … fragile: if the roster array is ever compacted, sorted, or re-indexed, the pointer breaks … Severity: MAJOR."* Fixed Pass 2 to stable UUID. The static critic loop is working for structural identity issues.
4. **agent-browser shadow-DOM limitation noted** (`manual-test-2.md:119-122`): `click @ref` doesn't reach buttons inside `cf-button` shadow DOM; the tester fell back to `eval` JS traversal. Tooling caveat, not a pattern defect — but worth hardening in the manual_test harness.
5. **Spec↔UX contradiction is the root generator of the bug:** spec said "render viewer with cf-profile-badge"; UX-design said "build the My-RSVP section (containing the badge) as a computed subtree." Neither stage knew these collide. No stage owns the "static-position" constraint.

---

## 9. RECOMMENDED FIXES (ranked)

### (a) Our exemplar `packages/patterns/event-rsvp/main.tsx` — **FIX REQUIRED before un-drafting** (highest priority)

It is browser-broken (§3). Concretely:

1. **Hoist the two `cf-profile-badge` sites to static positions** (like fair-share:264). Resolve `profileWish` once (already at line 281) and place `<cf-profile-badge $profile={profileWish.result}/>` as a **static** `[UI]` child, gating only siblings reactively — OR lift it into a tiny `const Badge = pattern<{profile}>(({profile}) => <cf-profile-badge $profile={profile}/>)` and render `<Badge profile={profileWish.result}/>` where a condition is unavoidable.
2. **Hoist the `$value` form controls out of computed subtrees too** (lines 392/398/404 create-form inputs; 533 note field). The current top-level `{computed(() => eventCreated ? … : …)}` blocks each wrap `$`-bound controls — restructure so the `$`-bound `cf-input`/`cf-textarea` live at static positions, and let `computed()`/`ifElse` switch only the *surrounding* content. (Pattern: `ifElse(eventCreated, <staticEventView/>, <staticCreateForm/>)` as children of a static wrapper, per repo-memory "use `ifElse` as a *child* of a static wrapper div, not as the `[UI]` value directly.")
3. **Add a render/smoke test** that actually renders `[UI]` (not just `.send()`), so the `h()` guard runs in CI. Without it, the exemplar can regress to blank again invisibly.
4. Update the file's header doc (it currently *claims* the badge drives a trusted "You" card, lines 11-12) to match whatever final placement ships.

> ⚠️ This contradicts the MEMORY note that the private-self-model series shipped clean — that series is `self.tsx` and unrelated; **this is the separate `event-rsvp` exemplar PR**, and it is browser-broken as written.

### (b) Docs — add the static-position caveat (high priority; prevents recurrence)

Add the boxed caveat from §4 to **both** `docs/common/components/COMPONENTS.md` (§ cf-profile-badge, ~line 857) **and** `docs/common/patterns/multi-user-patterns.md` (§ "Presenting Identity" / "Constraints to design within", ~line 232 & 266). Generalize it once to "all `$`-bindings" and cross-link `packages/patterns/scope-bug-computed-vnode-blank/main.tsx` as the canonical repro. This is the single change that would have prevented 71b6's DEFECT-1 and our exemplar's bug.

### (c) Factory wiring — give the critic a "`$`-binding inside computed()" lever (high priority)

The static critic blessed `$profile`-in-computed (it PASSED ID1 on the broken code). Add a **mechanical check** to the pattern-critic (Cat 5 "Binding" or a new sub-check):
> *"FAIL if any `$`-prefixed prop (`$value`/`$checked`/`$profile`/…) appears inside a `computed(() => …)` subtree (including computeds returned as `[UI]` children or assigned to intermediate VNode consts). `$`-bindings must be at a static `[UI]` position; inside a computed they throw 'Bidirectionally bound property … is not reactive' and blank the render. Fix: hoist to a static position or wrap in a sub-pattern."*
This is grep-able statically (no deploy needed) and would catch the defect one stage earlier than manual_test. Mirror it into `skills/pattern-critic/SKILL.md` and add an "identity/binding anti-patterns" gotcha under `docs/development/debugging/gotchas/`.

Secondary wiring: have the **ux-designer** stage flag when it places a `$`-bound control behind a conditional, or the **spec-interpreter** note that "render viewer with cf-profile-badge" implies a static-position requirement.

---

## 10. VERDICT — did the full+browser run confirm the pattern works?

**Partly. The browser run confirmed the factory CAN produce a working pattern — but only after it caught and fixed a render-blocking defect that all static gates missed.** Post-fix, `manual-test-2.md` verified all 8 target browser criteria PASS (create→event-view transition, RSVP submit, edit-in-place, live headcount, grouped list, empty state) with only 3 LOW defects (verbose date, viewer-group-when-sole-member, edit pre-select). Score 69 "Functional", with the −5 process penalty correctly pricing in the HIGH-defect rework. **The full pipeline is now genuinely end-to-end and the smoke phase is the missing safety net it was predicted to be.**

**What the badge finding means for un-drafting the PRs:**
- **Our `event-rsvp` exemplar PR: DO NOT un-draft as-is — it is browser-broken** (§3). Both `cf-profile-badge $profile=` sites *and* all create-form/note `$value` controls are inside `computed()` subtrees ⇒ blank UI in a real browser. The `.send()`-only tests give false green. **Fix (a) first** (hoist `$`-bindings to static positions + add a render smoke test), then it's safe to ship.
- **Docs PRs (b): un-draft only after adding the static-position caveat.** Shipping the current docs as the canonical identity reference would keep teaching the exact placement that blanks the UI.
- **The factory-wiring story is positive:** manual_test proved its value on its first run, and the recommended static `$`-binding critic check (c) would move the catch even earlier. The identity transfer itself (spec→build→critic→grade) remains intact — the only regression (ID2/ID7 → PARTIAL) is a framework-collision casualty, fully resolvable by the static-position fix, not an identity-competence failure.

**Bottom line:** the browser run validated the *pipeline* and surfaced a *real, generalizable framework gotcha* — and that same gotcha is currently latent in both our PR'd exemplar and our docs. Fix those two before un-drafting; the framework `$`-binding rule (static position only) is the load-bearing lesson of iter-3.
