---
name: pattern-test-to-integration
description: Convert Common Fabric pattern unit tests (`*.test.tsx` driven by actions and computed assertions) into browser integration tests (`packages/patterns/integration/*.test.ts`) that exercise the rendered UI and can be recorded with `deno task demo`. Use when asked to promote, mirror, spot-check, browser-test, or make a video demo from an existing pattern test, including multi-user pattern tests.
---

# Pattern Test to Integration

Treat the pattern test as the behavioral story, not as code to transliterate.
Re-express its meaningful state transitions through the real shell, browser,
rendered controls, and visible outcomes.

## Start from the current map

Read the source test, the pattern it instantiates, and these current references:

- `docs/common/ai/pattern-testing-guide.md` — pattern-test semantics, including
  multi-user participants.
- `packages/patterns/deno.jsonc` — the three test lanes and their CI/coverage
  roles.
- `docs/development/UI_TESTING.md` — shadow DOM, semantic locators, presentation
  behavior, and browser interaction rules.
- `docs/development/TESTING.md` — integration and `deno task demo` commands.
- `docs/development/waiting-in-tests.md` — required reading before introducing
  any polling.
- `packages/patterns/integration/cfc-browser-helpers.ts` — shared interaction,
  settling, effect-wait, and `StepTimer` seams.
- `packages/patterns/integration/pieces-controller.ts` — the local
  `PiecesController` initializer with the shared compile-byte cache.

Use working integration tests as executable examples:

- `packages/patterns/integration/nested-counter.test.ts` for a small
  single-browser interaction.
- `packages/patterns/integration/cfc-render-policy-demo.test.ts` for a concise,
  captioned demo.
- `packages/patterns/integration/lunch-poll-vote.test.ts` for two independent
  identities, browsers, and recordings on one shared timeline.

Prefer the nearest current test with the same topology over copying a generic
fixture. Tests are authoritative when a prose example has drifted.

Before choosing a destination, search `packages/patterns/integration/` for the
pattern name, source path, and intended scenario. Extend current browser
coverage when it already owns the story. If a separate scenario is clearer, give
it a specific filename and selector; never overwrite or duplicate an existing
test merely because the unit test has the shorter name.

## Preserve both test contracts

Keep the original colocated `*.test.tsx`. Pattern tests are the authored-pattern
coverage lane; a browser integration test does not replace that coverage.

Add the browser test under `packages/patterns/integration/` as `*.test.ts`. The
new test covers boundaries the pattern test intentionally omits: shell
navigation, rendering, shadow DOM, real event dispatch, browser identity, and
cross-client propagation.

Do not call the conversion complete if the browser test still performs the
primary scenario by sending the same output streams and reading the same result
fields directly. Direct piece operations remain useful for setup, invisible
invariants, persistence checks, and diagnostics; they are not substitutes for
the user-visible action and outcome.

## Translate intent across the boundary

Use this map as a starting point, then follow the actual UI:

| Pattern-test construct                       | Browser-test counterpart                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `Pattern({ inputs })`                        | Compile the source with `FileSystemProgramResolver`, then create a piece with `PiecesController.create(..., { input, start: true })` |
| `instance.action.send(value)`                | Fill, select, or click the rendered control that a user uses to cause that action                                                    |
| `computed(() => instance.field === value)`   | Wait for the corresponding rendered text, control state, list contents, or other observable DOM effect                               |
| `{ label }` / `{ await }` in `multiUserTest` | Coordinate real participant pages with event-driven waits on shared visible state                                                    |
| participant runtime                          | A `ShellIntegration` connected to the shared piece, with identity reuse or separation matching the unit test's user/session topology |

Preserve the scenario's causal ordering and important edge cases, but optimize
for a coherent browser story rather than one `it` block per unit assertion.
Group assertions that describe one visible state. An exhaustive internal
invariant with no UI manifestation should stay in the pattern test unless the
product is meant to expose it.

If the pattern has no rendered path for the behavior, say so explicitly. Add a
product UI seam only when the user's task authorizes changing the product; do
not create a test-only button or browser backdoor merely to force a conversion.

## Use the real integration lifecycle

Build from the closest fixture, retaining the local invariants it demonstrates:

- Bind every `ShellIntegration` lifecycle.
- Generate explicit identities and keep all participants in the intended shared
  space. Reuse one identity across multiple shells when the source test models
  multiple sessions for the same user; use distinct identities for distinct
  users.
- Resolve source through the runtime harness. Pass the patterns root to
  `FileSystemProgramResolver` when the source imports siblings outside its own
  directory.
- Pass initial unit-test inputs through `PiecesController.create`'s `input`
  option when they are part of the scenario.
- Keep the result demanded with a result-cell sink when pull-mode reactivity
  requires it, and cancel every sink during cleanup.
- Call `ensureDefaultPattern()` before browser navigation when the selected
  topology would otherwise race or cold-compile the space root; copy this seam
  only from a current fixture that explains why it is needed.
- Navigate with `ShellIntegration.goto(...)` and the generated identity.
- Dispose controllers and let bound shell lifecycles close browsers.

Use the helpers in `packages/patterns/integration/cfc-browser-helpers.ts` where
they already encode shadow traversal, one trusted interaction, view settling,
commit semantics, or an effect wait. Prefer accessible names and stable
product-facing selectors. Do not select by transient DOM structure when the UI
offers a semantic role, label, or explicit stable id.

## Keep correctness timing separate from presentation

Wait for a real state or DOM effect. Do not add `sleep`, `waitForTimeout`, or a
larger correctness timeout to make the video readable. Read
`docs/development/waiting-in-tests.md` before adding a bounded poll, and explain
why no event-driven observation exists if one is still necessary.

Make demo pacing an annotation of the same test:

- Give each shell stable `presentation` metadata; use distinct labels and colors
  for multiple participants.
- Wrap viewer-meaningful scenario boundaries in `StepTimer.run(label, action)`.
  Write labels for the viewer: describe what changes without leaking hidden or
  protected values before the UI reveals them.
- Keep using the existing click, fill, keyboard, and element paths. Presentation
  mode observes those paths; do not invent `demo.click()` or `demo.type()`.
- Preserve one real browser per participant. The demo compositor owns the
  side-by-side or grid layout.

The demo command records the complete selected `*.test.ts` file, including all
of its `it` blocks. Keep the file's ordered scenario meaningful as a whole. Do
not silently select ignored or environment-gated tests as default demos.

## Verify the paired result

Run the original pattern test before conversion to establish a clean baseline,
and again after any source/interface change:

```bash
deno task cf test packages/patterns/<pattern>/<name>.test.tsx
```

If the test imports sibling modules above its own directory, pass their common
source root just as the CLI error suggests, for example:

```bash
deno task cf test packages/patterns/<pattern>/<name>.test.tsx --root packages/patterns
```

Run the browser test through the integration selector, using its exact filename
stem:

```bash
deno task integration patterns <integration-test-name>
```

When demo output is part of the request and FFmpeg is available, record the same
test rather than a demo-only variant:

```bash
deno task demo patterns <integration-test-name>
```

Inspect the video or gallery when presentation quality matters. Passing tests
prove correctness; they do not prove that labels, pacing, framing, and
multi-user composition are understandable to a viewer.
