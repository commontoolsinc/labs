# Cell Passing Through compileAndRun - Proof of Concept

## Overview

This POC test verifies that `Cell` objects can be passed through the `compileAndRun` boundary and maintain their reference identity and reactivity.

## Test Architecture

### Files

1. **`cell-passing-poc.test.ts`** - Main test harness
   - Sets up the runtime environment
   - Compiles and runs the parent pattern
   - Provides the child pattern source code
   - Executes test assertions

2. **`cell-passing-poc-parent.test.tsx`** - Parent pattern
   - Creates a `Cell<string[]>` for shared state
   - Uses `compileAndRun` to load the child pattern
   - Passes the Cell as input to the child
   - Provides handlers to modify the shared Cell
   - Renders both parent and child UI

3. **Child pattern source** (embedded in test file)
   - Receives `Cell<string[]>` as input
   - Provides handlers to add/remove/clear items
   - Modifies the Cell directly
   - Renders the shared state

### Data Flow

```
┌─────────────────────────────────────────────┐
│ Parent Pattern                              │
│                                             │
│  ┌──────────────────┐                       │
│  │ Cell<string[]>   │◄──────┐               │
│  │  sharedItems     │       │               │
│  └──────────────────┘       │               │
│         │                   │               │
│         │ passed as input   │ modifications │
│         ▼                   │               │
│  ┌──────────────────────────┴──────────┐    │
│  │ compileAndRun                       │    │
│  │  ┌────────────────────────────────┐ │    │
│  │  │ Child Pattern (compiled)       │ │    │
│  │  │                                │ │    │
│  │  │  Receives: items: Cell<...>   │ │    │
│  │  │  Modifies via: set([...])     │─┼────┘
│  │  │                                │ │
│  │  └────────────────────────────────┘ │
│  └────────────────────────────────────┘
└─────────────────────────────────────────────┘
```

## What This Tests

1. **Cell Identity Preservation**: The same Cell instance is accessible in both parent and child
2. **Reactivity Across Boundary**: Changes made by child are immediately visible to parent
3. **Bidirectional Updates**: Both parent and child can modify the shared Cell
4. **Array Operations**: Standard array operations (add, remove, clear) work correctly
5. **Computed Values**: Computed values based on the Cell update in both contexts

## How to Run

### Prerequisites

1. Start the API server:
   ```bash
   cd packages/toolshed
   SHELL_URL=http://localhost:5173 deno task dev
   ```

2. In a new terminal, run the test:
   ```bash
   cd packages/runner
   deno task test integration/cell-passing-poc.test.ts
   ```

### Expected Output

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

## Success Criteria

The test passes if:

1. ✅ Child pattern compiles successfully via `compileAndRun`
2. ✅ Parent can add items to the shared Cell
3. ✅ The shared array contains both added items in order
4. ✅ No compilation or runtime errors occur
5. ✅ All assertions pass within the timeout period (3 minutes)

## What Success Proves

If this test passes, it demonstrates that:

- **Cell references are preserved** through the compilation boundary
- **The runtime correctly handles Cell types** in compiled code
- **Reactivity works across pattern boundaries**
- **The architecture supports the proposed solution** for passing Cells to dynamically loaded patterns
- **No special serialization is needed** - Cells work as direct references

## Next Steps After Success

Once this POC passes, we can proceed with:

1. Implementing the full solution in the actual codebase
2. Adding more comprehensive tests for edge cases:
   - Nested Cells
   - Cell<object> types
   - Multiple Cells passed to same child
   - Cell updates during compilation
3. Documenting the pattern for pattern developers
4. Creating examples showing best practices

## Troubleshooting

### Test times out during compilation
- Check that the API server is running
- Verify network connectivity to localhost:8000
- Check console for TypeScript compilation errors

### "Child pattern failed to compile in time"
- The child pattern source may have syntax errors
- Check the compiled.error field for details
- Increase the timeout or wait period

### Items not appearing in array
- Check that handlers are being called (look for console.log output)
- Verify Cell is being passed correctly to child
- Check for race conditions with runtime.idle() and storageManager.synced()

### Runtime errors
- Check Error.stackTraceLimit is set high enough
- Look for Cell method errors (get, set, etc.)
- Verify schema definitions match expected types
