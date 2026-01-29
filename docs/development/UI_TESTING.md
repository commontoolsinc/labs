<!-- @reviewed 2025-12-10 docs-rationalization -->

# Testing Shadow DOM Components with Astral

## The Problem

When testing web components that use Shadow DOM, traditional selectors can't
reach into shadow roots. This is especially challenging when components are
nested multiple levels deep, each with their own shadow DOM.

## The Solution: Data Attributes + Pierce Strategy

Instead of navigating through shadow DOM boundaries manually, we use **unique
data attributes on the actual HTML elements** combined with Astral's **pierce
strategy**.

### The Pattern

1. **Add data attributes to the actual HTML elements** (not the custom element
   wrapper)
   ```typescript
   // In ct-input component's render():
   <input 
     data-ct-input  // ← Unique identifier on the native element
     type="text"
     ...
   />

   // In ct-button component's render():
   <button
     data-ct-button  // ← Unique identifier on the native element
     ...
   >
   ```

2. **Use pierce strategy to find elements**
   ```typescript
   // This will find the input element no matter how deeply nested in shadow DOMs
   const input = await page.$("[data-ct-input]", {
     strategy: "pierce",
   });

   const button = await page.$("[data-ct-button]", {
     strategy: "pierce",
   });
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
     const element = await page.waitForSelector("[data-ct-input]", {
       strategy: "pierce"
     });
     return element !== null;
   });
   ```

## Why This Works

- **Pierce strategy** searches through all shadow DOM boundaries
- **Data attributes** provide unique, stable selectors
- **Native HTML elements** (input, button, etc.) are the actual interaction
  targets

## What Doesn't Work

❌ **Don't** put data attributes only on custom elements:

```html
<ct-button data-my-button>  <!-- Pierce won't find this reliably -->
```

❌ **Don't** try to navigate shadow paths manually:

```typescript
// This is fragile and breaks easily
const path = ["x-root", "#shadow-root", "ct-input", "#shadow-root", "input"];
```

## Example Test

```typescript
import { env, waitFor } from "@commontools/integration";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { Identity } from "@commontools/identity";
import { PiecesController } from "@commontools/piece/ops";

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
    const charm = await cc.create(yourPatternCode, { start: true });
    pieceId = charm.id;
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

    // Use waitFor() for reliable async assertions
    await waitFor(async () => {
      const input = await page.waitForSelector("[data-ct-input]", {
        strategy: "pierce",
      });
      await input.type("Hello World");
      return true;
    });

    // Click button
    const button = await page.waitForSelector("[data-ct-button]", {
      strategy: "pierce",
    });
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

1. **Use semantic data attributes**: `data-ct-input`, `data-ct-submit-button`,
   etc.
2. **Put attributes on the actual interactive element**: The `<input>`,
   `<button>`, not their wrappers
3. **Always wait for components to load**: Shadow DOM components may render
   asynchronously
4. **Use pierce strategy consistently**: It works for both finding and
   interacting with elements

## Debugging Tips

If pierce strategy isn't finding your element:

1. **Check the attribute is on the right element**: Use browser DevTools to
   verify the data attribute is on the actual HTML element, not a wrapper
2. **Ensure components are loaded**: Try increasing the wait time
3. **Verify the selector syntax**: `[data-my-attribute]` for presence,
   `[data-my-attribute="value"]` for specific values
4. **Test with simpler selectors first**: Try finding by tag name (`button`,
   `input`) to verify pierce is working
