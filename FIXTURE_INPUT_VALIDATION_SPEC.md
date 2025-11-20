# Fixture Input Validation - Specification

## Problem Statement

The ts-transformers fixture test suite validates **transformation correctness**
but not **input validity**. Input fixtures can contain invalid CommonTools code
that wouldn't compile in production, making them drift from real-world usage.

### Concrete Example

This input fixture currently passes tests but represents invalid CommonTools
code:

```typescript
// test/fixtures/ast-transform/schema-generation-builders.input.tsx
type TodoState = {
  items: string[]; // ❌ Invalid: Can't call .push() on plain array
};

const addTodo = handler<TodoEvent, { items: string[] }>((event, state) => {
  state.items.push(event.add); // ❌ This would fail in production
});
```

**The fix**: Use `Cell<string[]>` for mutable state:

```typescript
import { Cell } from "commontools";

type TodoState = {
  items: Cell<string[]>; // ✅ Valid: Cell for mutable state
};

const addTodo = handler<TodoEvent, { items: Cell<string[]> }>(
  (event, state) => {
    state.items.push(event.add); // ✅ Valid: Can push to Cell<string[]>
  },
);
```

**Why this matters**:

- Fixtures drift from real-world usage patterns
- Invalid patterns slip into the test suite as "examples"
- We can't trust fixtures as documentation of valid code
- Changes to CommonTools types might not catch broken fixtures

## Goal

**Validate that input fixtures represent valid CommonTools patterns before
transformation.**

When tests run, ensure input files would actually compile in production,
catching:

- Type errors (like `string[]` where `Cell<string[]>` is needed)
- Invalid CommonTools API usage
- Missing imports or type definitions

## Current vs. Proposed Behavior

### Current Fixture Pipeline

```
Input → Transform → Compare with Expected ✓
```

**Result**: Invalid input code passes tests

### Proposed Fixture Pipeline

```
Input → Type Check ✓ → Transform → Compare with Expected ✓
```

**Result**: Invalid input code fails tests with helpful error message

## Implementation Approach

### Add Type-Checking to Fixture Execution

Modify the fixture runner to validate inputs before transformation:

```typescript
// packages/ts-transformers/test/fixture-based.test.ts

const suiteConfig = {
  // ... existing config ...

  async execute(fixture: { relativeInputPath: string }) {
    return await transformFixture(
      `${config.directory}/${fixture.relativeInputPath}`,
      {
        types: { "commontools.d.ts": commontools },
        typeCheck: !!Deno.env.get("CHECK_INPUT"),
      },
    );
  },
};
```

### Shared Type-Checking Function

Create a reusable validation function:

```typescript
// packages/ts-transformers/test/type-checker.ts

import { Checker } from "@commontools/js-runtime/typescript/diagnostics";
import ts from "typescript";

export async function validateTypeScript(
  source: string,
  types: Record<string, string>,
): Promise<void> {
  const program = createTsProgram(source, types);
  const checker = new Checker(program);

  try {
    checker.typeCheck();
    checker.declarationCheck();
  } catch (error) {
    // Enhance error message with fixture context
    throw new Error(
      `Input fixture type checking failed:\n${formatDiagnostics(error)}`,
    );
  }
}

function createTsProgram(
  source: string,
  types: Record<string, string>,
): ts.Program {
  // Similar to utils.ts transformFiles, but simpler
  // Just create program for type-checking, no transformation
  // Can reuse existing code from utils.ts:33-176
}
```

### Test Output Example

When type errors are found in input:

```
Test failure: schema-generation-builders

Input fixture type checking failed:
  schema-generation-builders.input.tsx:13:3
    Error TS2339: Property 'push' does not exist on type 'string[]'
                  in mutable handler state context.

    13    state.items.push(event.add);
          ^^^^^

This input fixture contains invalid CommonTools code.

To fix:
1. Update the input fixture to use valid CommonTools patterns
   (e.g., use Cell<string[]> instead of string[] for mutable state)
2. If testing intentional error cases, add .skip or document in comments
```

## Rollout Strategy

### Step 1: Implement Validation (Opt-in by Default)

1. Add `typeCheck` option to `transformFiles` in `test/utils.ts`
2. Add validation call in `execute()` with `CHECK_INPUT` check
3. All existing tests continue to pass (validation disabled by default)

### Step 2: Identify Failing Fixtures

```bash
# Run all fixtures with validation enabled
CHECK_INPUT=1 deno task test
```

Document which fixtures fail and why.

### Step 3: Fix Fixtures

For each failing fixture, decide:

**A. Fix the input (preferred)**: Update to use valid CommonTools patterns

- Change `string[]` to `Cell<string[]>` for mutable state
- Add missing imports
- Fix type mismatches

**B. Document as intentional edge case (rare)**:

- Add comment explaining why input is invalid
- Consider if this fixture is actually testing the right thing
- Possibly convert to a different type of test

**C. Remove if obsolete**:

- Delete fixtures that no longer represent real usage
- Consolidate duplicates

### Step 4: Enable by Default

1. Change default from `!!Deno.env.get("CHECK_INPUT")` to
   `!Deno.env.get("SKIP_INPUT_CHECK")`
2. Update CI to enable CHECK_INPUT=1
3. Document the validation in test README

## Environment Variables

- `CHECK_INPUT=1`: Enable input validation (opt-in during rollout)
- `FIXTURE=name`: Run single fixture (already exists)
- `FIXTURE_PATTERN=pattern`: Run matching fixtures (already exists)

## Important Considerations

### Type System Strictness

The effectiveness depends on CommonTools type strictness. For the example above,
we need:

```typescript
// Simplified conceptual types
type HandlerState = {
  [K in keyof HandlerState]: Cell<any> | OpaqueRef<any> | /* primitives ok if not mutated */
};
```

If the type system isn't strict enough to catch semantic errors like pushing to
plain arrays, this validation will pass invalid code.

**Action**: Audit CommonTools type definitions to ensure they catch common
mistakes.

### Intentionally Invalid Fixtures

Some fixtures might test error handling or edge cases with invalid input.
Options:

1. **Move to separate directory**: `test/fixtures/invalid-input/`
2. **Skip validation**: Use `.skip()` or check fixture name
3. **Different test type**: Unit tests rather than fixture tests

### Relationship to Production Pipeline

The production `ct dev` pipeline:

1. Resolves the program
2. Creates TypeScript program with types
3. Type-checks with `Checker.typeCheck()`
4. Transforms with CommonToolsTransformerPipeline
5. Bundles output

This validation brings fixture tests closer to production by adding step 3
before transformation.

## Success Criteria

### Implementation Complete When:

- ✅ `validateTypeScript()` function exists and works
- ✅ Fixture runner calls validation before transformation
- ✅ Environment variable allows skipping during rollout
- ✅ Clear error messages point to specific type errors

### Rollout Complete When:

- ✅ All fixtures either pass validation or are documented exceptions
- ✅ Validation is enabled by default
- ✅ CI pipeline enforces input validity
- ✅ Documentation explains how validation works

## Benefits

1. **Prevents fixture drift**: Fixtures must use valid CommonTools patterns
2. **Catches type system changes**: Type definition updates caught automatically
3. **Better examples**: Fixtures become reliable code samples for users
4. **Earlier error detection**: Catch invalid patterns before transformation
5. **Aligns with production**: Tests mirror real-world compilation behavior

## Example Transformation: schema-generation-builders

### Before (Invalid, Currently Passes)

```typescript
type TodoState = {
  items: string[];
};

const addTodo = handler<TodoEvent, { items: string[] }>((event, state) => {
  state.items.push(event.add); // ❌ Fails in production
});
```

### After (Valid, Passes with Validation)

```typescript
import { Cell } from "commontools";

type TodoState = {
  items: Cell<string[]>;
};

const addTodo = handler<TodoEvent, { items: Cell<string[]> }>(
  (event, state) => {
    state.items.push(event.add); // ✅ Valid CommonTools code
  },
);
```

With validation enabled:

- **Before**: Test passes (no validation)
- **After**: Test fails with type error → Fix input → Test passes

## Technical Foundation

Infrastructure already exists in the codebase:

- **Type checking logic**:
  `packages/js-runtime/typescript/diagnostics/checker.ts`
- **Program creation**: `packages/ts-transformers/test/utils.ts` (lines 33-176)
- **Production usage**: `packages/runner/src/harness/engine.ts` (uses same
  Checker)

We just need to wire it into the fixture test runner.

## Future Work (Out of Scope)

- **Phase 1**: Post-transformation validation (validate expected outputs)
- **Phase 3**: Full pipeline testing through Engine.process()
- **Type system hardening**: Make CommonTools types stricter to catch more
  errors

This spec focuses solely on validating input fixtures before transformation.
