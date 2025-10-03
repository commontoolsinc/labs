# Pattern Testing Status

## Working Tests (with Type Checking)

### counter-aggregate-simple.test.ts ✅
- Initial state verification
- Button click interaction
- Status: **PASSING** (no --no-check needed)
- Location: `integration/patterns-with-ux/counter-aggregate-simple.test.ts`

### counter-aggregate.test.ts ✅
- Initial state verification
- Add counter via button click
- Update via direct operations
- Status: **PASSING** (no --no-check needed)
- Location: `integration/patterns-with-ux/counter-aggregate.test.ts`

## Known Limitations

### UI Interactions That Work
- ✅ Single button clicks
- ✅ Verifying initial UI render
- ✅ Direct state access with `charm.result.get()`
- ✅ Direct state mutations with `charm.result.set()`

### UI Interactions To Test
- ⚠️ Typing into `ct-input` elements - should work with pierce strategy
- ⚠️ Multi-step UI flows (type + click) - needs testing
- ⚠️ Form submissions - needs testing

### Correct Input Typing Pattern (from patterns/integration)
```typescript
// Option 1: Find ct-input by ID and type directly
const input = await page.waitForSelector("#my-input-id", {
  strategy: "pierce",
});
await input.click();
await input.type("text");

// Option 2: Find generic input element
const input = await page.waitForSelector("input", {
  strategy: "pierce",
});
await input.click();
await input.type("text");
```

### Pattern Issues
- **budget-planner**: ✅ Fixed `ifElse` import; ✅ Passes type checking; ⚠️ State mutation tests timeout
- **invoice-generator**: ✅ Fixed pattern exports and formatCurrency; ✅ Passes type checking; ⚠️ State mutation tests timeout

## Pattern Fixes Made

### invoice-generator.pattern.tsx
1. **Fixed formatCurrency** to handle undefined values safely
2. **Added missing exports**: `sanitizedItems`, `sanitizedTaxRate`, `sanitizedInvoiceDiscountRate` as aliases
3. Pattern now exports all fields expected by tests

## Test Files Migrated to patterns-with-ux/
All test files have been moved from `integration/` to `integration/patterns-with-ux/` and updated to:
- Use correct relative paths for pattern files
- Include proper TypeScript type assertions
- Pass `deno test -A` without `--no-check` flag

## Recommendations

For reliable tests:
1. Test initial UI renders using `waitFor` with heading text
2. Test button clicks for simple state changes
3. For input fields inside ct-input web components:
   - Use `page.waitForSelector('input[placeholder="..."]', { strategy: "pierce" })` to find the actual input element
   - The `pierce` strategy penetrates shadow DOM automatically
   - Typing on ct-input elements directly may not work - find the inner input element
4. Use direct operations (`charm.result.set()`) for complex state changes instead of UI
5. Expect `ConflictError` warnings in console - they auto-resolve
6. Don't await `charm.result.get()` - it's synchronous

## Test Template

```typescript
it("should test feature", async () => {
  const page = shell.page();
  
  // 1. Verify UI renders
  await waitFor(async () => {
    const headings = await page.$$("h1", { strategy: "pierce" });
    for (const heading of headings) {
      const text = await heading.evaluate((el: HTMLElement) => el.textContent);
      if (text?.includes("Expected Text")) return true;
    }
    return false;
  });

  // 2. Optional: Click a button
  const button = await page.waitForSelector("#button-id", {
    strategy: "pierce",
  });
  await button.click();

  // 3. Wait for state change
  await waitFor(async () => {
    const value = charm.result.get(["fieldName"]);
    return value === expectedValue;
  });

  // 4. Verify final state
  const value = charm.result.get(["fieldName"]);
  assertEquals(value, expectedValue);
});
```

## Running Tests

```bash
cd packages/runner
export API_URL=http://localhost:8000
deno test -A --no-check integration/counter-aggregate.test.ts
deno test -A --no-check integration/counter-aggregate-simple.test.ts
```

Ignore `ConflictError` warnings - they're normal and auto-resolve.
