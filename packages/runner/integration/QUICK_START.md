# Quick Start: Cell Passing POC Tests

## TL;DR

```bash
# Terminal 1: Start server
cd packages/toolshed
SHELL_URL=http://localhost:5173 deno task dev

# Terminal 2: Run simplified test (recommended first)
cd packages/runner
deno task test integration/cell-passing-poc-simple.test.ts

# Or run full test
deno task test integration/cell-passing-poc.test.ts
```

## Test Versions

### 1. Simplified Test (Recommended)
- **File:** `cell-passing-poc-simple.test.ts`
- **What:** Minimal test focusing on core Cell passing
- **Why:** Easier to debug, faster to run
- **When:** First run, quick validation

### 2. Full Test
- **File:** `cell-passing-poc.test.ts` + `cell-passing-poc-parent.test.tsx`
- **What:** Complete parent/child interaction with UI
- **Why:** Comprehensive validation
- **When:** After simplified test passes, for thorough testing

## Expected Result

```
✓ Child pattern compiles
✓ Cell is passed to child
✓ Child can modify Cell
✓ Parent sees modifications
✓ All assertions pass
```

## If Test Fails

1. Check server is running at `http://localhost:8000`
2. Look for compilation errors in output
3. Check for TypeScript syntax errors
4. See troubleshooting in `CELL_PASSING_POC.md`

## More Info

- **Architecture:** See `CELL_PASSING_POC.md`
- **Summary:** See `CELL_PASSING_POC_SUMMARY.md` in repo root
