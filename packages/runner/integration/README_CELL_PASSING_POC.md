# Cell Passing POC - Complete Test Suite

## What This Is

A proof-of-concept test suite that verifies `Cell<T>` objects can be passed through `compileAndRun` boundaries while maintaining reference identity and reactivity.

## Quick Start

```bash
# Terminal 1: Start API server
cd packages/toolshed
SHELL_URL=http://localhost:5173 deno task dev

# Terminal 2: Run test (from packages/runner)
cd packages/runner

# Option 1: Simplified test (recommended for first run)
deno task test integration/cell-passing-poc-simple.test.ts

# Option 2: Full test with UI
deno task test integration/cell-passing-poc.test.ts
```

## Files in This Suite

### Test Files

1. **`cell-passing-poc-simple.test.ts`** ⭐ Start here
   - Self-contained test with inline pattern sources
   - Focuses on core Cell passing mechanism
   - ~200 lines, easy to understand and debug
   - **Best for:** Quick validation, debugging

2. **`cell-passing-poc.test.ts`**
   - Full integration test with separate pattern files
   - Tests complete parent/child interaction
   - Includes UI rendering and multiple handlers
   - **Best for:** Comprehensive validation

3. **`cell-passing-poc-parent.test.tsx`**
   - Parent pattern source (used by full test)
   - Demonstrates real-world pattern structure
   - Shows compileAndRun usage

### Documentation

1. **`QUICK_START.md`**
   - Minimal instructions to run tests
   - Troubleshooting tips

2. **`CELL_PASSING_POC.md`**
   - Detailed architecture documentation
   - Data flow diagrams
   - Comprehensive troubleshooting

3. **`README_CELL_PASSING_POC.md`** (this file)
   - Overview of the test suite
   - File descriptions

### Root Documentation

- **`/Users/alex/Code/labs-2/CELL_PASSING_POC_SUMMARY.md`**
  - High-level summary for the entire repository
  - Why this matters, what success proves
  - Next steps after validation

## Test Architecture

### Simplified Test Flow

```
1. Compile parent pattern (inline source)
   ↓
2. Parent creates Cell<string[]>
   ↓
3. Parent uses compileAndRun with:
      - Child pattern source (inline)
      - Cell as input parameter
   ↓
4. Child compiles and receives Cell
   ↓
5. Test triggers child handler
   ↓
6. Child modifies Cell
   ↓
7. Parent sees modifications ✓
```

### Full Test Flow

```
1. Load parent pattern from file
   ↓
2. Compile parent with child source as input
   ↓
3. Parent creates Cell<string[]>
   ↓
4. Parent uses compileAndRun with Cell
   ↓
5. Child compiles (source embedded in test)
   ↓
6. Test adds items via parent handler
   ↓
7. Verify items appear in shared array
   ↓
8. Test adds more items
   ↓
9. Verify all items present and ordered ✓
```

## What Gets Tested

### Core Functionality
- ✅ Cell reference preservation across compileAndRun
- ✅ Parent can modify shared Cell
- ✅ Child can modify shared Cell
- ✅ Changes visible in both contexts
- ✅ Array operations (set, get) work correctly

### Edge Cases (in full test)
- ✅ Multiple items added sequentially
- ✅ Computed values update reactively
- ✅ Handler calls work across boundary
- ✅ UI rendering reflects state changes

## Expected Output

### Simplified Test Success

```
Simplified Cell Passing POC
API_URL: http://localhost:8000
Compiling parent pattern...
Parent charm created: did:key:...
Waiting for child to compile...
Child compiled successfully!

Test: Adding item through parent trigger...
[Parent] Triggering add: test-item-1
[Child] Added: test-item-1 Array: ['test-item-1']
Items in parent: ['test-item-1']
✓ Item added successfully!

Test: Adding second item...
[Parent] Triggering add: test-item-2
[Child] Added: test-item-2 Array: ['test-item-1', 'test-item-2']
Items after second add: ['test-item-1', 'test-item-2']
✓ Second item added successfully!

=== All tests passed! ===
Test completed successfully
```

### Full Test Success

```
Cell Passing POC Test
Connecting to: ws://localhost:8000/api/storage/memory
API_URL: http://localhost:8000

Parent recipe compiled successfully
Parent charm ID: did:key:...
Waiting for child pattern to compile...
Child pattern compiled and ready!

=== Test 1: Add item through parent ===
[Parent] Added item: Item from parent Array now: ['Item from parent']
Items after parent add: ['Item from parent']

=== Test 2: Add second item ===
[Parent] Added item: Second item Array now: ['Item from parent', 'Second item']
Items after second add: ['Item from parent', 'Second item']

=== Test 3: Verify both items ===

=== All tests passed! ===
✓ Cell passing through compileAndRun works correctly
✓ Parent can modify Cell
✓ Changes are visible across pattern boundary
✓ Array mutations work as expected

Test completed successfully within timeout
```

## Common Issues

### Server Not Running
```
Error: Connection refused (os error 61)
```
**Solution:** Start toolshed server (see Quick Start)

### Type Check Failures
```
error: Type checking failed
```
**Solution:** Run `deno check <file>` to see specific errors

### Compilation Timeout
```
Error: Child pattern failed to compile in time
```
**Solution:**
- Check child source for syntax errors
- Look for compilation errors in output
- Increase wait time in test if needed

### Items Not Appearing
```
Error: Expected 'test-item-1' in items, got: []
```
**Solution:**
- Verify handler is being called (check console.log)
- Ensure runtime.idle() and storageManager.synced() are called
- Check Cell is passed in input object

## Type Checking

All files type-check successfully:

```bash
cd packages/runner

# Check individual files
deno check integration/cell-passing-poc.test.ts
deno check integration/cell-passing-poc-simple.test.ts
deno check integration/cell-passing-poc-parent.test.tsx

# All should show: ✓ Check file:///.../filename
```

## Next Steps

### After Tests Pass

1. ✅ Validate architecture works as expected
2. ✅ Document findings
3. ✅ Share with team

### For Implementation

1. Use this pattern in actual codebase
2. Add tests for additional edge cases:
   - Nested Cells
   - Multiple Cells to same child
   - Cell updates during compilation
   - Different Cell types (object, primitive)

3. Create documentation for pattern developers
4. Add examples to pattern library

### For Future Work

1. Consider TypeScript helpers for type safety
2. Add runtime validation for Cell types
3. Performance testing with many Cells
4. Security review for untrusted pattern sources

## Design Decisions

### Why Two Test Versions?

**Simplified:**
- Easier to understand
- Faster to debug
- Self-contained
- Good for CI/CD

**Full:**
- More realistic
- Tests UI integration
- Validates complete workflow
- Better for comprehensive validation

### Why Inline Pattern Sources?

- Makes test self-contained
- Easier to modify for experimentation
- No file dependencies
- Clear what's being tested

### Why Cell<string[]>?

- Simple type to work with
- Easy to verify contents
- Demonstrates array operations
- Generalizes to other types

## Success Criteria

The POC is successful if:

1. ✅ Both test versions pass
2. ✅ No type errors in any file
3. ✅ All assertions succeed
4. ✅ No runtime errors
5. ✅ Tests complete in < 30 seconds (excluding compilation)

## Contact & Support

For questions or issues:
1. Check `CELL_PASSING_POC.md` for detailed troubleshooting
2. Review test output for error messages
3. Verify server is running and accessible
4. Check that all files type-check successfully

## References

- **compileAndRun implementation:** `packages/runner/src/builtins/compile-and-run.ts`
- **Cell implementation:** `packages/runner/src/cell.ts`
- **Pattern API:** `packages/api/index.ts`
- **Example patterns:** `packages/patterns/examples/`
