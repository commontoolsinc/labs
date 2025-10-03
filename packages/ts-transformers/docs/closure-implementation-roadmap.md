# Closure Implementation Roadmap

_Created: 2025-09-24_ _Updated: 2025-10-02_ _Status: Phase 1 Complete_

## Executive Summary

This roadmap provides a concrete, step-by-step plan for implementing closure
support in the CommonTools TypeScript transformer for **OpaqueRef array map
callbacks**. We've successfully completed Phase 1 (OpaqueRef Map Callbacks) with
a clean, standalone architecture.

## Implementation Status

✅ **PHASE 1 COMPLETE**: Map callback transformation fully working

### What We Built

1. **Standalone Closure Transformer** (`src/closures/transformer.ts`)
   - Independent of opaque-ref transformer
   - Transforms map callbacks on `OpaqueRef<T[]>` and `Cell<T[]>` that have captures
   - Does NOT transform plain `T[].map()`
   - Runs FIRST in the pipeline
   - Self-contained with own import management

2. **Selective Capture Detection** (Node Identity Approach)
   - Leverages TypeScript's symbol table
   - Uses direct node identity checks (works because we run first!)
   - Captures variables from outer scopes but EXCLUDES:
     - Module-scoped declarations (top-level constants/functions)
     - Function declarations (handlers, lift(), etc.)
     - Global built-ins
   - INCLUDES captures from parent callback scope (nested maps)
   - Handles all edge cases: JSX, nested properties, local variables

3. **Clean Pipeline Architecture** (`src/transform.ts`)
   ```typescript
   Closure → OpaqueRef → Schema
   ```

4. **Unified Test Infrastructure**
   - All tests use `commonTypeScriptTransformer`
   - Automatic correct ordering
   - Fixture-based testing approach

### Key Architectural Decisions

1. **Closure as Separate Transformer**: Not a rule within opaque-ref
   - Conceptually cleaner (closures ≠ reactivity)
   - Reusable for non-OpaqueRef scenarios
   - Independent testing and development

2. **Run First in Pipeline**: Critical for simplicity
   - Operates on clean, untransformed AST
   - TypeChecker + node identity checks work reliably
   - Source position approach NOT needed (simpler!)

3. **Node Identity Works**: Because we run first
   - Closure transformer sees original AST
   - TypeChecker built from original program
   - Both reference same nodes → `node === func` works!

4. **Reactive Arrays Only**: Transform `OpaqueRef<T[]>.map()` and `Cell<T[]>.map()`
   - Targets reactive array map operations
   - Does NOT transform plain array maps
   - Selectively captures variables (excludes module-scoped and functions)

## Implementation Phases

### Phase 1: Map Callback Transformation ✅ COMPLETE

**Status**: Fully implemented and tested

#### What Works

```typescript
// Input: state.items has type OpaqueRef<Item[]>
state.items.map((item, index) => item.price * state.discount + state.tax);

// Output
state.items.map(
  recipe(({ elem, index, params: { discount, tax } }) =>
    elem.price * discount + tax
  ),
  { discount: state.discount, tax: state.tax },
);
```

#### What Doesn't Transform

```typescript
// Plain arrays - NOT transformed
[1, 2, 3].map((n) => n * multiplier); // Left as-is

// Cell arrays - NOT transformed
cellRef.map((item) => item * multiplier); // Left as-is
```

#### Implementation Details

**Capture Detection** (`collectCaptures`):

1. Walk callback body visiting all identifiers
2. For each identifier, get symbol from TypeChecker
3. Get declarations for symbol
4. Check if ANY declaration is outside callback using **node identity**
5. **Filter out module-scoped declarations** (walk AST to SourceFile parent)
6. **Filter out function declarations** (including handlers, CallExpressions)
7. Handle special cases (JSX tags, attributes, property names)
8. Capture valid variables (from outer/parent scopes, excluding filtered ones)

**Key Insight**: Node identity `current === func` works because:

- Closure transformer runs on original AST
- TypeChecker references original AST
- They're the same objects!

**Type Checking** (`isMapCall`):

- Only matches `OpaqueRef<T[]>.map()` calls
- Rejects `Cell<T[]>.map()` and plain `T[].map()`
- Uses TypeChecker to get the type string and checks for "OpaqueRef<"

**Transformation** (`transformMapCallback`):

1. Collect all captured expressions
2. Build params object: `{ discount: state.discount, ... }`
3. Transform callback parameters:
   - `item` → destructured `{ elem, params: { discount } }`
   - Keep `index` if present
4. Replace captured refs in body: `state.discount` → `discount`
5. Wrap callback in `recipe(...)`
6. Rewrite map call: `map(recipe(...), params)`
7. Add `recipe` import if needed

#### Edge Cases Handled

✅ Nested property access (`state.user.name`)
✅ Multiple captures (selective - excludes module-scoped/functions)
✅ Module-scoped constants/functions (NOT captured)
✅ Handler functions (NOT captured)
✅ Nested callbacks (DOES capture from parent callback scope)
✅ JSX elements and attributes (not captured)
✅ Variables declared inside callback (not captured)
✅ Callback parameters (not captured)
✅ Index parameter preservation
✅ Plain arrays (not transformed)
✅ Cell arrays (ARE transformed)

#### Test Coverage

- ✅ Single captured variable
- ✅ Multiple captured variables (selective)
- ✅ Module-scoped constants (NOT captured)
- ✅ Module-scoped functions (NOT captured)
- ✅ Handler references (NOT captured)
- ✅ Nested callbacks (parent scope capture)
- ✅ Nested property access
- ✅ Mixed with reactive expressions
- ✅ JSX in callbacks
- ✅ No false positives (local vars, params, JSX, module-scoped, functions)

### Phase 2: Event Handler Support (PLANNED)

**Status**: Not yet started

#### Goal

Transform event handlers with captures:

```typescript
// Input
<button onClick={() => state.count++}>

// Output
<button onClick={handler((_, {count}) =>
  count.set(count.get() + 1),
  {count: state.count}
)}>
```

#### Implementation Steps

1. **Detect Event Handler Context**
   - JSX event handler attributes (onClick, onChange, etc.)
   - Inline arrow functions in handler positions
   - Captured state variables

2. **Handle State Mutations**
   - Detect mutations: assignments, updates (++, --), method calls
   - Transform to Cell API when appropriate

3. **Create Tests**
   - `event-handler-read.input.tsx` / `.expected.tsx`
   - `event-handler-mutation.input.tsx` / `.expected.tsx`

#### Open Questions

- Does runtime have `handler()` helper?
- How to detect which captures need mutable vs. read-only access?
- Should we transform non-mutating handlers?

### Phase 3: Generic Closure Support (PLANNED)

**Status**: Not yet started

#### Goal

Transform arbitrary closures:

```typescript
// Input
const compute = () => state.a + state.b;

// Output
const compute = lift(({ a, b }) => a + b).curry({ a: state.a, b: state.b });
```

#### Implementation Steps

1. **Detect Generic Closures**
   - Variable declarations with arrow functions
   - Function expressions
   - Return statements with functions

2. **Implement Lift+Curry Pattern**
   - Verify runtime support for curry
   - Transform to lift+curry pattern
   - Handle edge cases

3. **Edge Cases**
   - Nested closures
   - Closures returning closures
   - Async closures

#### Open Questions

- Does runtime support `.curry()` method?
- Alternative pattern if curry not available?
- Performance implications?

## Architecture Deep Dive

### Why Node Identity Works (Critical Understanding)

**The Problem We Solved**: Initially, we thought node identity wouldn't work
because of transformer sequencing. We were wrong! Here's why:

**TypeScript Transformation Pipeline**:

```
Original Source → TypeChecker built here
     ↓
[Closure Transformer] ← Sees original AST
     ↓ (creates new AST)
[OpaqueRef Transformer] ← Sees closure-transformed AST
     ↓ (creates new AST)
[Schema Transformer] ← Sees both transformations
     ↓
Final Output
```

**Key Insight**: TypeChecker is built ONCE from original source and never
updated.

**For Closure Transformer** (runs first):

- ✅ Works with original AST
- ✅ TypeChecker references original AST
- ✅ Node identity (`===`) works perfectly
- ✅ Simple, direct scope checking

**For Later Transformers** (run after):

- ❌ Work with transformed AST
- ❌ TypeChecker still references original AST
- ❌ Node identity fails (comparing different trees)
- ✅ Must use TypeRegistry or similar patterns

### TypeRegistry Pattern (For Context)

The Schema transformer uses TypeRegistry to pass Type information forward:

```typescript
// Schema-injection rule creates synthetic node:
const syntheticNode = factory.createCallExpression(...);
typeRegistry.set(syntheticNode, originalType);

// Schema transformer later retrieves it:
const type = typeRegistry.get(node) || checker.getTypeFromTypeNode(node);
```

**Note for Future Work**: Consider if opaque-ref transformer needs similar
pattern for passing information about transformed nodes. Once closures are fully
stable, investigate whether a "TransformationRegistry" or similar could help
later transformers understand what earlier ones did.

### Source Position Approach (Not Used)

We initially considered using source position ranges:

```typescript
// Check if declaration position is within callback position
const isWithin = declStart >= callbackStart && declEnd <= callbackEnd;
```

**Why We Didn't Need It**:

- More complex
- Less semantically clear
- Node identity is simpler and more reliable (since we run first)

**When Source Positions Would Be Needed**:

- If transformer ran AFTER other transformations
- If synthetic nodes without positions were involved
- If node identity checks were unreliable

## Files Modified/Created

### Core Implementation ✅

1. **`src/closures/transformer.ts`** - NEW
   - Standalone closure transformer
   - Capture detection with node identity
   - Map callback transformation
   - Import management

2. **`src/closures/types.ts`** - NEW
   - Type definitions (currently minimal)

3. **`src/transform.ts`** - MODIFIED
   - Added closure transformer as first in pipeline
   - Clear ordering: Closure → OpaqueRef → Schema

4. **`src/mod.ts`** - MODIFIED
   - Export `createClosureTransformer`
   - Export `commonTypeScriptTransformer`

### Test Infrastructure ✅

1. **`test/utils.ts`** - MODIFIED
   - Now uses `commonTypeScriptTransformer`
   - Removed old `applySchemaTransformer` option
   - Simpler, unified approach

2. **`test/fixture-based.test.ts`** - MODIFIED
   - Added closures configuration
   - Removed transformer options (now automatic)

3. **`test/fixtures/closures/`** - NEW
   - `map-single-capture.input.tsx`
   - `map-single-capture.expected.tsx`
   - More fixtures to be added for Phase 2/3

4. **`test/opaque-ref/map-callbacks.test.ts`** - NEW
   - Specific test for map callback transformation
   - Tests interaction with OpaqueRef transformer

## Success Criteria

### Phase 1 ✅ COMPLETE

- [x] Capture detection reliably identifies all captured variables
- [x] No false positives (local vars, params, JSX)
- [x] Map callbacks with captures transform correctly
- [x] Fixture tests pass
- [x] No regression in existing tests
- [x] Clean architectural separation
- [x] Node identity approach validated

### Phase 2 (Event Handlers) - TODO

- [ ] Event handler context detection working
- [ ] State mutations handled correctly
- [ ] Cell API integration working
- [ ] Event handler fixtures pass
- [ ] No regression

### Phase 3 (Generic Closures) - TODO

- [ ] Generic closure detection working
- [ ] Lift+curry pattern implemented
- [ ] Runtime compatibility verified
- [ ] Edge cases handled
- [ ] Full test suite passes

## Next Steps

### Immediate (Finish Phase 1)

1. ✅ Remove debug logging from transformer
2. ✅ Update documentation (this file)
3. ✅ Implement module-scoped filtering
4. ✅ Implement function declaration filtering
5. ✅ Implement nested callback transformation
6. ✅ Fix all test expectations
7. ✅ All 70 fixture tests passing

### Phase 2 Planning

1. Research event handler patterns in existing code
2. Verify runtime has `handler()` helper or equivalent
3. Design mutation detection strategy
4. Create fixture test cases
5. Implement in iterative steps

### Phase 3 Planning

1. Verify runtime support for lift+curry
2. Design alternative if curry not available
3. Research edge cases in existing codebase
4. Create comprehensive test plan

## Lessons Learned

1. **Run First = Simplicity**: Operating on original AST is much simpler
2. **Node Identity Works**: When using original AST + TypeChecker together
3. **Standalone > Embedded**: Closure transformer being separate is cleaner
4. **Selective Capture is Critical**: Not everything should be captured
   - Module-scoped declarations are available everywhere (don't capture)
   - Functions can't be serialized (don't capture)
   - Parent callback scope SHOULD be captured (enables nested maps)
5. **TypeChecker is Static**: Always references original source, never updated
6. **Transformation Order Matters**: Nested callbacks must transform before parameter replacement

## Open Questions

1. **Performance**: Is capture detection fast enough for large files?
2. **Caching**: Should we cache capture analysis results?
3. **Type Preservation**: Do we maintain TypeScript types correctly?
4. **Source Maps**: How to preserve debugging experience?
5. **Runtime Curry**: Does runtime support `.curry()` for Phase 3?

## Documentation Status

- ✅ `closure-design.md` - Updated with final architecture
- ✅ `closure-implementation-roadmap.md` - This file
- ⏳ Inline code comments - Needs review and cleanup
- ⏳ Migration guide - Not yet needed (backwards compatible)
