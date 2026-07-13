<!-- @reviewed 2025-12-10 docs-rationalization -->

# Testing Shadow DOM Components

## The Problem

When testing web components that use Shadow DOM, traditional selectors can't
reach into shadow roots. This is especially challenging when components are
nested multiple levels deep, each with their own shadow DOM.

## Preferred Solution: Accessibility Locators

For interactive `cf-*` components, prefer semantic locators against the custom
element host. Components such as `cf-button` and `cf-input` expose roles and
ARIA state directly on the host, so tests and browser agents can find controls
without traversing shadow roots.

### The Pattern

1. **Give controls stable accessible names**

   Use visible text for buttons, or use `aria-label`, an associated label, or a
   placeholder for inputs.

   ```typescript
   // Shown as JSX element children.
   <cf-button>Submit</cf-button>
   <cf-input aria-label="Email" type="email" />
   ```

2. **Find controls by role and accessible name**

   ```bash
   # agent-browser
   agent-browser find role button click --name "Submit"
   agent-browser snapshot -i          # → textbox "Email" [ref=e3]
   agent-browser type @e3 "user@example.com"
   ```

   ```typescript
   // Shown inside a pattern body.
   // Browser test APIs with ARIA support should use the same role/name shape.
   const submit = page.getByRole("button", { name: "Submit" });
   const email = page.getByRole("textbox", { name: "Email" });
   ```

3. **Use ShellIntegration for setup**
   ```typescript
   // Shown inside a pattern body.
   const shell = new ShellIntegration();
   shell.bindLifecycle(); // Sets up beforeAll/afterAll hooks

   // shell.goto() handles navigation, applyConsoleFormatter, and login
   await shell.goto({
     frontendUrl: FRONTEND_URL,
     view: { spaceName: SPACE_NAME, pieceId },
     identity,
   });

   // Wait for state event-drivenly — never sleep, never poll. waitForCondition
   // installs a waiter inside the page that resolves the instant the DOM
   // reflects the condition, instead of re-checking from the test process on a
   // fixed interval.
   await waitForCondition(page, (probe: ProbeApi) =>
     probe.collect("cf-input[role='textbox']").length > 0);
   ```

## Why This Works

- **Host roles** make `cf-*` components visible to accessibility-based
  automation
- **Accessible names** let agents find the intended control by user-facing text
- **Shadow DOM remains intact** for style isolation while host elements become
  semantic anchors

## Fallback: Data Attributes + Pierce Strategy

For older components that do not expose host roles yet, use unique data
attributes on the actual HTML elements combined with Astral's pierce strategy.

```typescript
// Shown inside a pattern body.
const input = await page.$("[data-cf-input]", {
  strategy: "pierce",
});

const button = await page.$("[data-cf-button]", {
  strategy: "pierce",
});
```

## `fill()` Does Not Work on cf-\* Hosts

Playwright's `fill()` requires a native `<input>` or `<textarea>`. Since
`cf-input` and `cf-textarea` are custom elements, use
`pressSequentially()` on the locator instead. The custom element host is the
semantic tab stop and forwards focus to the inner native input automatically:

```typescript
// Shown inside a pattern body.
const input = page.getByRole("textbox", { name: "Email" });
await input.pressSequentially("user@example.com");
```

For `agent-browser`, use `type @ref` (not bare `type` after `click`):

```bash
agent-browser snapshot -i            # → textbox "Email" [ref=e3]
agent-browser type @e3 "user@example.com"
```

## What Doesn't Work

❌ **Don't** rely on unlabeled controls:

```html
<cf-input></cf-input>
```

❌ **Don't** try to navigate shadow paths manually:

```typescript
// This is fragile and breaks easily
const path = ["x-root", "#shadow-root", "cf-input", "#shadow-root", "input"];
```

## Example Test

```typescript
// Shown at module scope.
import {
  awaitViewSettled,
  env,
  waitForCondition,
} from "@commonfabric/integration";
import { ShellIntegration } from "@commonfabric/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { Identity } from "@commonfabric/identity";
import { PiecesController } from "@commonfabric/piece/ops";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("shadow DOM component test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: PiecesController;
  let pieceId: string;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await PiecesController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const piece = await cc.create(yourPatternCode, { start: true });
    pieceId = piece.id;
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  it("should interact with shadow DOM components", async () => {
    const page = shell.page();

    // Setup: shell.goto() handles navigation, applyConsoleFormatter, and login
    await shell.goto({
      frontendUrl: FRONTEND_URL,
      view: { spaceName: SPACE_NAME, pieceId },
      identity,
    });

    // Settle the view so each control's handler is bound before acting (see
    // "Waiting Until the UI Is Interactive" below), then act once.
    await awaitViewSettled(page);
    const input = await page.waitForSelector("cf-input[role='textbox']");
    await input.type("Hello World");

    await awaitViewSettled(page);
    const button = await page.waitForSelector("cf-button[role='button']");
    await button.click();

    // Verify the effect event-drivenly: waitForCondition resolves the instant
    // the result text appears, with no test-side poll.
    await waitForCondition(page, (probe) =>
      probe.collect("#result").some((el) =>
        probe.deepText(el).includes("Hello World")
      ));
  });
});
```

## Waiting Until the UI Is Interactive

Finding an element is one problem; knowing *when* it is ready to be clicked or
typed into is a separate one. The reactive scheduler runs in a worker while the
DOM lives on the main thread, so after a state change there are three stages
before a control is interactive:

1. the worker settles reactively — `rt.idle()` covers this;
2. the resulting vdom batch crosses to the main thread and is applied — this is
   where the click listener is attached;
3. the Lit elements finish their update cycle — `cf-modal`, for example, only
   binds handlers and removes `pointer-events: none` in its `updated()`
   callback, one cycle after its `open` property is set.

Only stage 1 is visible through the runtime idle signal, so an element can exist
in the DOM, be found by a selector, and still drop a click because its handler
is not bound yet.

**Use `awaitViewSettled(page)`** from `@commonfabric/integration` before issuing
the first click or keystroke after navigation or any state change. It resolves
once all three stages are done, so a single click then lands on a bound handler:

```typescript
// Shown at module scope.
import {
  awaitViewSettled,
  waitForCondition,
} from "@commonfabric/integration";

// Before interacting: wait until the shell has exposed its settle hook, then
// settle the view so the click lands on a bound handler.
await waitForCondition(page, () =>
  typeof (globalThis as {
    commonfabric?: { viewSettled?: unknown };
  }).commonfabric?.viewSettled === "function");
await awaitViewSettled(page);
const button = await page.waitForSelector("cf-button[role='button']");
await button.click(); // delivered to a bound handler

// After interacting: settle once, then wait for the click's specific effect
// event-drivenly. The modal opening is a DOM mutation, so waitForCondition's
// in-page waiter resolves the instant it appears.
await awaitViewSettled(page);
await waitForCondition(page, (probe) =>
  probe.collect("cf-modal[open]").length > 0);
```

Pattern integration tests can reach for the higher-level wrappers in
`packages/patterns/integration/cfc-browser-helpers.ts` — `waitForText`,
`fillCfInput`, `clickCfButton`, `clickCfButtonAndWaitForText` — which bundle
"settle the view, act once, wait for the effect" on top of these primitives.

### Do not reach for these instead

Each of the following is what `awaitViewSettled` replaces. They are either racy
(they do not cover all three stages) or wasteful (a CDP round trip every poll):

- **`await sleep(ms)`, `page.waitForTimeout(ms)`, or any fixed delay** — guesses
  at timing; too short flakes, too long wastes wall-clock.
- **`await rt.idle()` or `waitForRuntimeIdle(page)` alone, then interact** —
  covers stage 1 only. The element may be in the DOM with no handler bound, or
  be a `cf-modal` whose `pointer-events` are still off.
- **`await waitFor(() => findButtonWithText(page, "X"))` then click** — presence
  is not interactivity, and every poll is a CDP `evaluate` round trip. The
  `waitFor` helper re-runs its predicate from the test process on a fixed
  interval; prefer `waitForCondition`, whose in-page waiter resolves on the DOM
  mutation itself (see `packages/integration/utils.ts`).
- **`await waitFor(() => clickButtonWithText(page, "X"))`, re-clicking until it
  "takes"** — fires the stimulus speculatively. It can double-fire (creating
  duplicate state) and, against a `dismissable` overlay such as `cf-modal`,
  repeated clicks behind the open modal dismiss it and leave the test stuck.
- **`page.waitForSelector(...)` in a retry loop to "wait it out"** — Astral's
  `waitForSelector` is itself a tight CDP poll, and a present element is not a
  ready one.

The shape is always: settle the view, click once, then wait for the effect —
never poll-and-pray, and never re-click.

A CI check enforces this for the polling `waitFor`: `deno task check-no-waitfor`
fails when an integration test imports `waitFor` from
`@commonfabric/integration`. See
[`waitfor-migration.md`](./waitfor-migration.md) for the rationale, the full
event-driven toolkit, and the allowlist of intentional exceptions.

## Best Practices

1. **Use roles first**: `button`, `textbox`, `checkbox`, etc.
2. **Give controls accessible names**: visible text, labels, `aria-label`, or
   placeholders
3. **Always wait for components to load**: Shadow DOM components may render
   asynchronously
4. **Use pierce strategy as fallback**: It remains useful for components that
   have not been updated with host semantics

## Running the Tests Locally

`deno task integration` starts the servers for you. These are browser tests, so
the toolshed must serve the shell frontend, not just the API: a bare `deno task
dev` toolshed returns `404` for the UI and the test times out. To run a single
file by hand, point it at the compiled binary (`deno task build-binaries`, then
`./dist/toolshed`) or a source toolshed with `SHELL_URL` set.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `HEADLESS` | Set to `true` or `1` to run browser headlessly (default: visible) |
| `PIPE_CONSOLE` | Set to `true` or `1` to forward browser console output to the test runner |
| `API_URL` | Server URL (default: `http://localhost:8000`) |
| `FRONTEND_URL` | Frontend URL (default: `API_URL`) |
| `SPACE_NAME` | Target a specific space (default: random UUID) |

Example: `PIPE_CONSOLE=1 deno task integration`

## Debugging Tips

If semantic locators are not finding your element:

1. **Check the host role**: `cf-button` should have `role="button"`;
   `cf-input` should have `role="textbox"`
2. **Check the accessible name**: ensure visible text, `aria-label`, a label, or
   placeholder matches the locator
3. **Ensure components are loaded**: wait for the host element before querying
4. **Fallback to pierce selectors**: use `[data-cf-input]` or
   `[data-cf-button]` with `strategy: "pierce"` for older components

## Related documentation

- [TESTING.md](TESTING.md) — running the suites and the general unit and
  integration test structure.
- [COVERAGE.md](COVERAGE.md) — how CI measures coverage and feeds the
  coverage-debt gate.
