# Exemplar fix — `event-rsvp` render-blocking `$`-binding bug

**Scope:** `packages/patterns/event-rsvp/main.tsx` + `main.test.tsx` (worktree
`/tmp/labs-fix`, branch `ct-1676-multi-user-identity`). The identity/data model
was left unchanged; only the `[UI]` structure was restructured and a render
smoke test added.

**Problem (per `docs/investigations/research/iter3-full-eval.md` §1–§3, §9a):**
the exemplar rendered a BLANK UI in a browser because every `$`-bidirectional
binding (`$profile` on the two `cf-profile-badge`s, `$value` on the create-form
`cf-input`s and the note input) sat inside a `computed(() => …)` `[UI]` subtree.
At a static position `h()` (`packages/html/src/h.ts:72-92`) sees the binding's
value as a live Cell/CellResult and passes; inside a `computed()` body the
runtime has already auto-unwrapped it to a plain value, so `h()` throws
`Bidirectionally bound property … is not reactive` on the first settle cycle and
blanks the entire render. The `.send()`-only tests never rendered `[UI]`, so
40/40 (here 15/15) green was fully consistent with a 100%-blank browser.

---

## Before → after `[UI]` structure

### Before (broken)

`[UI]` opened a `<cf-vstack>` whose **direct children were four
`{computed(() => eventCreated ? … : …)}` blocks**, each containing `$`-bound
controls:

- create/view switch `{computed(() => eventCreated ? <eventHeader> : <createForm>)}` (~L347)
  - **`$value={titleDraft}`** (L392), **`$value={dateTimeDraft}`** (L398),
    **`$value={locationDraft}`** (L404) — inside the computed
  - **`<cf-profile-badge $profile={profileWish.result}>`** "Hosting as" (L418)
    — inside the computed
- "You" card `{computed(() => eventCreated ? … : null)}` (~L446)
  - **`<cf-profile-badge $profile={profileWish.result}>`** "You are" (L457) —
    inside the computed
  - **`$value={messageDraft}`** note input (L533) — inside the computed
- headcount `{computed(…)}` and roster `{computed(() => grouped.map(…))}` — no
  `$`-bindings, but also computed children of `[UI]`

Every one of the 6 live `$`-bindings was regenerated on each settle → guaranteed
throw → blank.

### After (fixed)

`[UI]` is now a **static `<cf-vstack>` wrapper whose single child is
`{ifElse(eventCreated, eventView, createForm)}`** (main.tsx L695-699), exactly
the repo-memory idiom ("use `ifElse` as a CHILD of a static wrapper div, not as
the `[UI]` value directly"), mirroring `fair-share/main.tsx:264` (badge at a
static position).

- **`const createForm`** (L372) — a pre-built **static** subtree (the
  before-create view). Its `$`-bound controls are constructed **once** at
  pattern-build time.
- **`const eventView`** (L442) — a pre-built **static** subtree (the
  after-create view: event header, "You are" identity card, headcount, roster).
  Its `$`-bound controls are constructed once.
- `ifElse(eventCreated, eventView, createForm)` swaps the two static subtrees.
- Reactive/derived content (join button, RSVP status `.map`, guest counter,
  headcount, roster `grouped.map`, "(you)" highlighting) still lives in
  `computed()`/`ifElse` subtrees — but **none of those computeds wraps a
  `$`-bound control** (they contain only `cf-button`/`cf-avatar`/`cf-text`/
  `cf-badge`, which take no `$`-binding).

`ifElse` was added to the `commonfabric` import (main.tsx L52).

---

## All `$`-bindings are now STATIC — new locations

Verified mechanically (each binding's enclosing `const` subtree is reached by
walking upward before any `computed(` is encountered):

| `$`-binding | Control | New static location | Enclosing static subtree |
|---|---|---|---|
| `$value={titleDraft}` | `cf-input#event-title-input` | main.tsx **L380** | `createForm` (L372) |
| `$value={dateTimeDraft}` | `cf-input#event-when-input` | main.tsx **L389** | `createForm` (L372) |
| `$value={locationDraft}` | `cf-input#event-where-input` | main.tsx **L397** | `createForm` (L372) |
| `$profile={profileWish.result}` | `cf-profile-badge#hosting-as-badge` ("Hosting as") | main.tsx **L413** | `createForm` (L372) |
| `$profile={profileWish.result}` | `cf-profile-badge#you-are-badge` ("You are") | main.tsx **L490** | `eventView` (L442) |
| `$value={messageDraft}` | `cf-input#note-input` (note) | main.tsx **L572** | `eventView` (L442) |

No `$`-binding remains inside any `computed()` body.

---

## Wiring changes forced by the restructure (minimal)

1. **`ifElse` import** added (main.tsx L52).
2. **Two `const` subtrees** (`createForm`, `eventView`) extracted before the
   pattern `return`, so each `$`-bound control's `h()` runs once at build time.
3. **Stable `id`s** added to the six `$`-bound controls (`event-title-input`,
   `event-when-input`, `event-where-input`, `hosting-as-badge`, `you-are-badge`,
   `note-input`) so the render smoke test can locate them in the realized tree.
4. **Note input made always-present (static), disabled until joined.** Before,
   the note `$value` input only existed inside the `isJoined` computed. To keep
   it at a static position it is now rendered unconditionally inside `eventView`
   with `disabled={computed(() => !isJoined)}` on both the input and its Save
   button (reactive `disabled=` on a sibling prop is permitted — `fair-share`
   does the same on `cf-button`, L268), plus a reactive "RSVP above to add a
   note." hint. The RSVP **status buttons** and **guest counter** carry no
   `$`-binding, so they stay inside the `isJoined` computed (genuinely hidden
   pre-join). This is the only behavioral change: the note field is visible but
   disabled before joining, instead of absent.
5. **Header doc** updated with a 5th bullet documenting the static-`[UI]` rule
   (main.tsx L24-32). **Identity/data model untouched:** `cf-profile-badge` for
   the viewer (now static), `cf-avatar` for others, the
   `#profile`/`#profileName`/`#profileAvatar` wishes, join+snapshot roster, the
   `PerUser` cell-reference `me` pointer, `equals()`/cell-ref identity, and the
   `PerSpace`/`PerUser`/`PerSession` split are all unchanged.

---

## Render smoke test (the key new check)

Added to `main.test.tsx`. Approach (same mechanism as
`packages/patterns/cfc-group-chat-demo/main.test.tsx`, which walks `chat[UI]`):
the test **walks the realized `subject[UI]` VNode tree** with an inlined
depth-first `findNodeById` (helpers inlined so the test stays self-contained in
its own directory — no `--root` needed). Walking calls `.get()` on every nested
cell/computed as it descends, which **forces the pattern's `[UI]` computed
subtrees to evaluate — i.e. it runs `h()` on every `$`-bound control**. That is
the step that the `.send()`-only tests never did.

Three assertions (test step indices `assertion_4`, `assertion_5`, `assertion_9`):

- **`assert_render_create_form`** (before create): the three create-form
  `$value` inputs and the "Hosting as" `$profile` badge all render at static
  positions (checked via a live-binding probe: the `$`-prop resolves to an
  object link, never an unwrapped primitive).
- **`assert_render_no_event_view_before_create`** (sanity): the event-view-only
  controls are absent before create.
- **`assert_render_event_view`** (after create): the "You are" `$profile` badge
  and the note `$value` input render at static positions.

### Why this test fails on the old structure and passes on the fix (verified)

Validated by temporarily swapping the original (broken) `main.tsx` back in and
re-running the **same** test file:

- **OLD broken `main.tsx`:** `TEST_EXIT 1` — `✗ assertion_4`, `✗ assertion_8`,
  and `✗ 2 runtime error(s) during test: Error: Bidirectionally bound property
  $profile is not reactive` → **16 passed, 3 failed.** The walk into the
  computed-wrapped `$`-bindings makes `h()` throw, surfaced both as the render
  assertions returning false and via the runner's runtime-error path.
- **FIXED `main.tsx`:** `TEST_EXIT 0` → **18 passed, 0 failed.**

So the smoke test would catch a regression to the blank-UI structure.

### `expectNonIdempotent: true` (scoped, documented)

The render assertions resolve `subject[UI]`, which contains live `$`-bindings.
Resolving a `$`-bound VNode's props **materializes a binding-target link**
(`h.ts` `bindingTargetLink` → `getAsLink`), and the runner's idempotency
double-check (every computation is re-run in a second transaction and its
**writes** compared — `packages/cli/lib/test-runner.ts:857`,
`packages/runner/src/scheduler/diagnosis.ts`) sees those link-materialization
writes differ between the two runs. This is an **expected artifact of rendering
`$`-bound nodes inside a re-runnable assertion** — exactly the write side effect
that makes `$`-bindings belong at a build-once static position — not a defect in
the pattern's handlers. The flag is set on the test output (file-scoped) and
documented inline. It does **not** weaken the smoke test: the broken structure
fails via the independent **runtime-error** path (`allowRuntimeErrors` stays
false), which this flag does not touch; the 15 value-assertions still pin
handler behavior exactly. (Confirmed: with all render assertions skipped, the
suite is 15/0 with zero non-idempotency, isolating the source to the `$`-bound
`[UI]` traversal.)

---

## Verification (deno 2.8.1, `cf` CLI, run from `/tmp/labs-fix`)

| Check | Command | Result |
|---|---|---|
| Compiles (main) | `deno task cf check packages/patterns/event-rsvp/main.tsx --no-run` | **exit 0**, 0 errors |
| Compiles (test) | `deno task cf check packages/patterns/event-rsvp/main.test.tsx --no-run` | **exit 0**, 0 errors |
| Tests pass | `deno task cf test packages/patterns/event-rsvp/main.test.tsx` | **18 passed, 0 failed** (1 non-idempotent, expected), exit 0 |
| Render (broken→fail) | same test vs the original broken `main.tsx` | **16 passed, 3 failed**, 2 runtime errors — the bug is caught |
| Lint | `deno lint` on both files | **exit 0**, "Checked 2 files" |

**Browser render-check is left to the parent** (dev server up on
http://localhost:8100) as the final confirmation; the structural fix + compile +
unit render smoke test are solid and the broken-vs-fixed differential is proven.

---

## Bottom line

Every `$`-binding (`$profile` ×2, `$value` ×4) now sits at a static `[UI]`
position inside one of two pre-built static subtrees switched by `ifElse` as a
child of a static wrapper; no `$`-binding is inside a `computed()`. The pattern
compiles, all 18 tests pass (15 original value-assertions + 3 new render smoke
assertions), and the render smoke test demonstrably fails on the old structure
and passes on the fix. The identity/data model is unchanged.
