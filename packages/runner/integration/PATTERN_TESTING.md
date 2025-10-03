# Pattern Testing Guide

This guide explains how to create integration tests for patterns in `packages/runner/integration/patterns-with-ux`.

## Overview

Integration tests for patterns-with-ux verify both:
1. **UI interactions** - Testing that users can interact with the pattern's UI
2. **State management** - Testing that the charm's state is correctly updated

## Test Structure

Integration tests follow this pattern:

```typescript
import { env, waitFor } from "@commontools/integration";
import { CharmController, CharmsController } from "@commontools/charm/ops";
import { ShellIntegration } from "@commontools/integration/shell-utils";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { assert, assertEquals } from "@std/assert";
import { Identity } from "@commontools/identity";
import { FileSystemProgramResolver } from "@commontools/js-runtime";

const { API_URL, FRONTEND_URL, SPACE_NAME } = env;

describe("pattern name test", () => {
  const shell = new ShellIntegration();
  shell.bindLifecycle();

  let identity: Identity;
  let cc: CharmsController;
  let charm: CharmController;

  beforeAll(async () => {
    identity = await Identity.generate({ implementation: "noble" });
    cc = await CharmsController.initialize({
      spaceName: SPACE_NAME,
      apiUrl: new URL(API_URL),
      identity: identity,
    });
    const sourcePath = join(
      import.meta.dirname!,
      "patterns-with-ux",
      "pattern-name.pattern.tsx",
    );
    const program = await cc.manager().runtime.harness
      .resolve(
        new FileSystemProgramResolver(sourcePath),
      );
    charm = await cc.create(
      program,
      { start: true },
    );
  });

  afterAll(async () => {
    if (cc) await cc.dispose();
  });

  // Tests go here...
});
```

## Adding Test IDs to Patterns

To make patterns testable, add `id` attributes to interactive elements:

### Buttons

```tsx
<ct-button
  id="my-button-id"
  onClick={handler}
>
  Button Text
</ct-button>
```

### Inputs

```tsx
<ct-input
  id="my-input-id"
  $value={fieldCell}
  placeholder="Enter value"
/>
```

### Naming Convention

Use descriptive kebab-case IDs:
- `add-counter-button`, `adjust-counter-button`
- `category-select`, `amount-input`
- `balance-targets-button`, `reset-all-button`

## Writing Tests

### Finding Elements by ID

Use `waitForSelector` with the `pierce` strategy to find elements:

```typescript
const button = await page.waitForSelector("#my-button-id", {
  strategy: "pierce",
});
assert(button, "Should find button");
```

### Interacting with ct-input Elements

`ct-input` is a web component with a shadow DOM. To type into it:

```typescript
// 1. Find the ct-input by ID
const ctInput = await page.waitForSelector("#my-input-id", {
  strategy: "pierce",
});

// 2. Find the underlying input element within the shadow DOM
const inputElement = await ctInput.waitForSelector("input", {
  strategy: "pierce",
});

// 3. Click and type
await inputElement.click();
await inputElement.type("value");
```

### Clearing Input Values

To clear a value before typing a new one:

```typescript
await inputElement.evaluate((el: HTMLInputElement) => {
  el.value = "";
});
await inputElement.click();
await inputElement.type("new value");
```

### Clicking Buttons

```typescript
const button = await page.waitForSelector("#button-id", {
  strategy: "pierce",
});
await button.click();
```

### Waiting for State Changes

Use `waitFor` to wait for the charm state to update:

```typescript
await waitFor(async () => {
  const value = await charm.result.get(["fieldName"]);
  return value === expectedValue;
});
```

### Verifying State

After UI interactions, verify the charm state:

```typescript
const value = await charm.result.get(["fieldName"]);
assertEquals(value, expectedValue, "Field should be updated");
```

### Testing Direct Operations

Also test direct charm operations without UI:

```typescript
it("should update via direct operation", async () => {
  await charm.result.set(newValue, ["fieldName"]);

  await waitFor(async () => {
    const value = await charm.result.get(["fieldName"]);
    return value === newValue;
  });

  const value = await charm.result.get(["fieldName"]);
  assertEquals(value, newValue, "Field should be updated");
});
```

## Running Tests

Tests require a running server. Use the `API_URL` environment variable:

```bash
# Run a single test
cd packages/runner
API_URL=http://localhost:8000 deno test -A --no-check integration/pattern-name.test.ts

# Run all runner integration tests
cd packages/runner
API_URL=http://localhost:8000 deno test -A --no-check integration/
```

## Example: Counter Aggregate Pattern

### Pattern Changes (minimal IDs added):

```tsx
// Add ID to button
<ct-button
  id="add-counter-button"
  onClick={addBound}
>
  + Add New Counter
</ct-button>

// Add ID to inputs
<ct-input
  id="counter-index-input"
  $value={indexField}
  placeholder="e.g., 0, 1, 2"
/>

<ct-input
  id="counter-amount-input"
  $value={amountField}
  placeholder="e.g., 5 or -3"
/>

// Add ID to adjust button
<ct-button
  id="adjust-counter-button"
  onClick={adjustBound}
>
  Adjust Counter
</ct-button>
```

### Test Example:

```typescript
it("should add a new counter via UI button", async () => {
  const page = shell.page();

  // Find and click the add counter button by ID
  const addButton = await page.waitForSelector("#add-counter-button", {
    strategy: "pierce",
  });
  assert(addButton, "Should find add counter button");
  await addButton.click();

  // Wait for the counter to be added
  await waitFor(async () => {
    const counters = await charm.result.get(["counters"]);
    return Array.isArray(counters) && counters.length === 1;
  });

  const counters = await charm.result.get(["counters"]) as number[];
  assertEquals(counters[0], 0, "New counter should start at 0");
});

it("should adjust counter value via UI form", async () => {
  const page = shell.page();

  // Find the index input by ID and type into the underlying input element
  const indexInput = await page.waitForSelector("#counter-index-input", {
    strategy: "pierce",
  });
  const indexInputElement = await indexInput.waitForSelector("input", {
    strategy: "pierce",
  });
  await indexInputElement.click();
  await indexInputElement.type("0");

  // Find the amount input by ID and type into the underlying input element
  const amountInput = await page.waitForSelector("#counter-amount-input", {
    strategy: "pierce",
  });
  const amountInputElement = await amountInput.waitForSelector("input", {
    strategy: "pierce",
  });
  await amountInputElement.click();
  await amountInputElement.type("5");

  // Click the adjust button
  const adjustButton = await page.waitForSelector("#adjust-counter-button", {
    strategy: "pierce",
  });
  await adjustButton.click();

  // Wait for state update
  await waitFor(async () => {
    const counters = await charm.result.get(["counters"]) as number[];
    return counters[0] === 5;
  });

  const total = await charm.result.get(["total"]);
  assertEquals(total, 5, "Total should be 5");
});
```

## Best Practices

1. **Minimal Changes**: Only add IDs to interactive elements, don't restructure code
2. **Use Descriptive IDs**: IDs should clearly describe the element's purpose
3. **Test Both UI and State**: Verify UI interactions work AND state is updated correctly
4. **Wait for State Changes**: Always use `waitFor` when expecting async state updates
5. **Test Direct Operations**: Include tests that bypass the UI to test charm logic directly
6. **Handle Shadow DOM**: Remember that `ct-input` and other web components use shadow DOM
7. **Add Default Export**: Patterns must export a default export for FileSystemProgramResolver

## Common Patterns

### Pattern Must Have Default Export

```tsx
export const myPatternUx = recipe<Args>(/*...*/);

// Add this at the end:
export default myPatternUx;
```

### Testing Forms with Multiple Fields

```typescript
// Get all inputs
const categoryInput = await page.waitForSelector("#category-select", {
  strategy: "pierce",
});
const categoryInputElement = await categoryInput.waitForSelector("input", {
  strategy: "pierce",
});
await categoryInputElement.click();
await categoryInputElement.type("value1");

const amountInput = await page.waitForSelector("#amount-input", {
  strategy: "pierce",
});
const amountInputElement = await amountInput.waitForSelector("input", {
  strategy: "pierce",
});
await amountInputElement.click();
await amountInputElement.type("value2");

// Submit
const submitButton = await page.waitForSelector("#submit-button", {
  strategy: "pierce",
});
await submitButton.click();
```

### Testing State After Page Load

```typescript
it("should load pattern and verify initial state", async () => {
  const page = shell.page();
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    spaceName: SPACE_NAME,
    charmId: charm.id,
    identity,
  });

  // Wait for UI to render
  const heading = await page.waitForSelector("h1", {
    strategy: "pierce",
  });
  assert(heading, "Should find heading");

  // Verify initial charm state
  const initialValue = await charm.result.get(["fieldName"]);
  assertEquals(initialValue, expectedInitialValue);
});
```

## Transaction Conflicts (Normal Behavior)

When running tests that interact with the UI (clicking buttons, typing in inputs), you **will** see `ConflictError` warnings in the console. **This is normal and expected** - the system automatically recovers from these conflicts within milliseconds.

**What you'll see:**
```
[WARN][storage.cache::...] Transaction failed {
  name: "ConflictError",
  message: "The application/json of...was expected to be X, but it is Y"
  ...
}
```

**Why this happens:**
- Both the test code and the UI are updating charm state concurrently
- The system uses optimistic concurrency control
- Conflicts are detected and automatically retried
- Tests continue successfully after auto-recovery

**Important:** Don't be alarmed by conflict warnings - they're part of normal operation and are handled automatically. Your tests should pass despite these warnings.

**Working test example with UI interactions:**
```typescript
it("should add item via button click", async () => {
  const page = shell.page();
  await shell.goto({
    frontendUrl: FRONTEND_URL,
    spaceName: SPACE_NAME,
    charmId: charm.id,
    identity,
  });

  // Wait for UI to fully render
  await waitFor(async () => {
    const headings = await page.$$("h1", { strategy: "pierce" });
    for (const heading of headings) {
      const text = await heading.evaluate((el: HTMLElement) => el.textContent);
      if (text?.includes("Pattern Name")) return true;
    }
    return false;
  });

  // Click the add button
  const addButton = await page.waitForSelector("#add-item-button", {
    strategy: "pierce",
  });
  await addButton.click();

  // Wait for state to update (conflicts will occur and auto-resolve)
  await waitFor(async () => {
    const items = charm.result.get(["items"]);
    return Array.isArray(items) && items.length === 1;
  });

  // Verify the item was added
  const items = charm.result.get(["items"]) as SomeType[];
  assertEquals(items[0], expectedValue);
});
```

**Key points:**
- Use `waitFor` to poll state until the expected condition is true
- Don't await `charm.result.get()` - it's synchronous
- Give conflicts time to resolve (usually <1 second)
- Tests will pass despite conflict warnings in the console
```

## Troubleshooting

### Element Not Found
- Verify the ID is correct in both pattern and test
- Make sure you're using `strategy: "pierce"` to penetrate shadow DOM
- Check that the element is rendered (might need to wait)
- Some elements may not be the first h1/h2 on the page - use `page.$$()` to get all matches and search through them

### Type Errors
- Use `--no-check` flag when running tests to skip TypeScript checking
- Add type assertions when needed: `as number[]`, `as SomeType`

### UI Interaction Failures
- Element might not be clickable yet - add small delays or wait for state
- Shadow DOM: remember to find the underlying `input` element inside `ct-input`
- Clear previous values before typing new ones in forms
- **Transaction conflicts are normal** - see "Transaction Conflicts" section above

### State Not Updating
- Use `waitFor` to give async operations time to complete
- Check that the handler is properly bound in the pattern
- Verify the state path is correct: `["field"]` vs `["nested", "field"]`
- **Do not await** `charm.result.get()` calls - they return values synchronously

### Heading/Element Text Mismatch
- The first `waitForSelector("h1")` might find a different h1 than expected
- Use `page.$$("h1")` to get all h1 elements and search for the one containing your text
- Always wait for the specific content to appear using `waitFor` instead of just waiting for the element
