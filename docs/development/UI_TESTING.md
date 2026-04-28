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
   <cf-button>Submit</cf-button>
   <cf-input aria-label="Email" type="email" />
   ```

2. **Find controls by role and accessible name**

   ```typescript
   // agent-browser
   agent-browser find role button click --name "Submit"
   agent-browser find role textbox fill "user@example.com" --name "Email"
   ```

   ```typescript
   // Browser test APIs with ARIA support should use the same role/name shape.
   const submit = page.getByRole("button", { name: "Submit" });
   const email = page.getByRole("textbox", { name: "Email" });
   ```

3. **Use ShellIntegration for setup**
   ```typescript
   const shell = new ShellIntegration();
   shell.bindLifecycle(); // Sets up beforeAll/afterAll hooks

   // shell.goto() handles navigation, applyConsoleFormatter, and login
   await shell.goto({
     frontendUrl: FRONTEND_URL,
     view: { spaceName: SPACE_NAME, pieceId },
     identity,
   });

   // Use waitFor() for reliable async assertions (not sleep!)
   await waitFor(async () => {
     const element = await page.waitForSelector("cf-input[role='textbox']");
     return element !== null;
   });
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
`pressSequentially()` on the locator instead — `delegatesFocus` forwards
focus to the inner native input automatically:

```typescript
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
import { env, waitFor } from "@commonfabric/integration";
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

    // Prefer host semantics for cf-* controls.
    await waitFor(async () => {
      const input = await page.waitForSelector("cf-input[role='textbox']");
      await input.type("Hello World");
      return true;
    });

    const button = await page.waitForSelector("cf-button[role='button']");
    await button.click();

    // Verify results with waitFor
    await waitFor(async () => {
      const result = await page.waitForSelector("#result", {
        strategy: "pierce",
      });
      const text = await result.evaluate((el: HTMLElement) => el.textContent);
      return text?.includes("Hello World");
    });
  });
});
```

## Best Practices

1. **Use roles first**: `button`, `textbox`, `checkbox`, etc.
2. **Give controls accessible names**: visible text, labels, `aria-label`, or
   placeholders
3. **Always wait for components to load**: Shadow DOM components may render
   asynchronously
4. **Use pierce strategy as fallback**: It remains useful for components that
   have not been updated with host semantics

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
