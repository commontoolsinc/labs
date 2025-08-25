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

3. **Ensure components are fully loaded**
   ```typescript
   await page.goto(url);
   await page.applyConsoleFormatter(); // Important for CommonTools shell
   await shell.login(); // Ensures proper auth state
   await sleep(500); // Wait for components to render
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
it("should interact with shadow DOM components", async () => {
  const { page } = shell.get();

  // Setup
  await page.goto(`${FRONTEND_URL}${spaceName}/${charmId}`);
  await page.applyConsoleFormatter();
  await shell.login();
  await sleep(500); // Let components render

  // Find and interact with elements using data attributes
  const input = await page.$("[data-ct-input]", { strategy: "pierce" });
  await input.type("Hello World");

  const button = await page.$("[data-ct-button]", { strategy: "pierce" });
  await button.click();

  // Verify results
  const result = await page.$("#result", { strategy: "pierce" });
  assert(result, "Should find result element");
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
