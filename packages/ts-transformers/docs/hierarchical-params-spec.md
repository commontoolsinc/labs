# Hierarchical Params Transformation Spec

## Overview

This spec describes a proposed refactoring of our map closure transformation to
use hierarchical parameter structures that preserve the original code's variable
names and structure, eliminating the need for body rewriting.

## Current Approach vs Proposed Approach

### Current Transformation

**Input:**

```typescript
state.items.map((item) => <span>{item.price * (1 - state.discount)}</span>);
```

**Current Output:**

```typescript
state.items.mapWithPattern(
  recipe({
    type: "object",
    properties: {
      element: { ... },  // item type
      params: {
        type: "object",
        properties: {
          discount: { type: "number", asOpaque: true }
        }
      }
    }
  },
  ({ element, params: { discount } }) => (
    <span>{element.price * (1 - discount)}</span>
  )),
  { discount: state.discount }
)
```

**Problems:**

1. Renamed `item` → `element` (loses semantic meaning)
2. Flattened `state.discount` → `discount` (loses structure)
3. Body requires rewriting to match new names
4. Destructured params create binding elements, not parameters
5. TypeChecker symbol resolution breaks for synthetic nodes

### Proposed Transformation

**Input:**

```typescript
state.items.map((item) => <span>{item.price * (1 - state.discount)}</span>);
```

**Proposed Output:**

```typescript
state.items.mapWithPattern(
  recipe({
    type: "object",
    properties: {
      element: { ... },
      params: {
        type: "object",
        properties: {
          state: {
            type: "object",
            properties: {
              discount: { type: "number", asOpaque: true }
            }
          }
        }
      }
    }
  },
  ({ element: item, params: { state } }) => (
    // BODY UNCHANGED!
    <span>{item.price * (1 - state.discount)}</span>
  )),
  { state: { discount: state.discount } }
)
```

**Benefits:**

1. Body is **completely unchanged** (except for nested map transforms)
2. Original variable names preserved (`item`, `state`)
3. Hierarchical structure maintained (`state.discount`)
4. No explicit renaming pass required—destructuring aliases map canonical names
   to the originals while preserving runtime expectations
5. Symbol resolution works correctly
6. Easier to debug/understand generated code

## Implementation Requirements

### 1. Capture Analysis (No Change)

The existing `collectCaptures()` function already identifies captured
expressions:

- `state.discount` → captured expression
- `state.taxRate` → captured expression

### 2. Hierarchical Grouping (NEW)

**New Function:** `groupCapturesByRoot()`

Takes captured expressions and groups them by root identifier:

```typescript
Input captures: [state.discount, state.taxRate, other.foo]

Output structure:
{
  "state": {
    properties: ["discount", "taxRate"],
    expressions: [state.discount, state.taxRate]
  },
  "other": {
    properties: ["foo"],
    expressions: [other.foo]
  }
}
```

### 3. Schema Generation (MODIFIED)

**Current:** Generates flat params object

```typescript
params: {
  type: "object",
  properties: {
    discount: { type: "number", asOpaque: true },
    taxRate: { type: "number", asOpaque: true }
  }
}
```

**Proposed:** Keep the callback contract (`params` property) but mirror the
capture tree inside it

```typescript
params: {
  type: "object",
  properties: {
    state: {
      type: "object",
      properties: {
        discount: { type: "number", asOpaque: true },
        taxRate: { type: "number", asOpaque: true }
      }
    }
  }
}
```

The runtime contract continues to surface a `params` object to the callback,
and we supply the capture tree as the second argument. Runtime passes that
object through unchanged, so destructuring `params: { state }` recovers the
original identifiers without an extra wrapper layer.

### 4. Parameter Naming (MODIFIED)

**Current:** Fixed names `element`, `index`, `params` (then destructure params)

**Proposed:** Alias the canonical runtime names to the original identifiers via
destructuring while keeping captures under `params`:

- Element parameter: `({ element: item })`
- Index parameter (if present): `({ index: i })`
- Captured roots: `({ params: { state, checkout } })`

The runtime still receives `{ element, index, array, params }`, but the callback
body uses the original vocabulary with no additional rewrite pass.

### 5. Params Object Creation (MODIFIED)

**Current:** Flat object with extracted property names

```typescript
{ discount: state.discount, taxRate: state.taxRate }
```

**Proposed:** Hierarchical object matching the capture tree

```typescript
{
  state: {
    discount: state.discount,
    taxRate: state.taxRate
  }
}
```

### 6. Body Transformation (SIMPLIFIED)

**Current transformations:**

1. Rename element parameter (`item` → `element`)
2. Transform destructured properties (`{price}` → `element.price`)
3. Replace captures (`state.discount` → `discount`)

**Proposed transformations:**

1. ~~Rename element parameter~~ ❌ REMOVED (handled via destructuring aliases)
2. Transform destructured properties (`{price}` → `item.price`) ✅ KEEP (but use
   the aliased identifier)
3. ~~Replace captures~~ ❌ REMOVED – captures already have correct names through
   the hierarchical `params`
4. Cache computed destructuring keys once per callback (e.g.,
   `{ [nextKey()]: value }`) so expressions with side effects still run exactly
   once. New regression fixture:
   `packages/ts-transformers/test/fixtures/closures/map-computed-alias-side-effect.*`

The key insight: **If the params object mirrors the source structure we can
preserve the original syntax with minimal AST edits while remaining compatible
with the runtime contract.**

### 7. Implementation Plan (UPDATED)

1. Reuse `collectCaptures` + `groupCapturesByRoot` to build a capture tree of
   root identifiers.
2. Generate the recipe `TypeNode` and JSON schema with `element` plus
   hierarchical properties under `params`.
3. Emit the callback binding pattern that aliases `element/index/array/params`
   to the original identifiers.
4. Update the body by:
   - rewriting destructured element bindings to property/element access using
     the aliased identifier;
   - caching computed property names once per callback (new regression fixture
     ensures we never regress this behaviour);
   - leaving capture references untouched.
5. Build the runtime capture object from the tree (e.g., `{ state: { ... } }`)
   and rely on runtime to expose it under the callback's `params` property.
6. Extend regression coverage: keep the existing alias fixtures, numeric alias
   test, collision fixture, and the new computed-side-effect case.

> ⚠️ **Runtime contract reminder:** `mapWithPattern` still receives
> `{ element, index, array, params }`. The refactor must continue to supply this
> shape and rely on destructuring aliases to recover the original names. No
> runtime changes required.

## Edge Cases

### Multiple Root Captures

**Input:**

```typescript
items.map((item) => item.price * state.discount + config.taxRate);
```

**Output:**

```typescript
items.mapWithPattern(
  recipe({
    type: "object",
    properties: {
      element: { ... },
      params: {
        type: "object",
        properties: {
          state: {
            type: "object",
            properties: {
              discount: { type: "number", asOpaque: true }
            }
          },
          config: {
            type: "object",
            properties: {
              taxRate: { type: "number", asOpaque: true }
            }
          }
        }
      }
    }
  },
  ({ element: item, params: { state, config } }) => (
    item.price * state.discount + config.taxRate
  )),
  {
    state: { discount: state.discount },
    config: { taxRate: config.taxRate }
  }
)
```

### Deep Property Access

**Input:**

```typescript
items.map((item) => item.price * state.pricing.discount);
```

**Output:**

```typescript
items.mapWithPattern(
  recipe({
    properties: {
      element: { ... },
      params: {
        type: "object",
        properties: {
          state: {
            type: "object",
            properties: {
              pricing: {
                type: "object",
                properties: {
                  discount: { type: "number", asOpaque: true }
                }
              }
            }
          }
        }
      }
    }
  },
  ({ element: item, params: { state } }) => (
    item.price * state.pricing.discount
  )),
  { state: { pricing: { discount: state.pricing.discount } } }
)
```

Wait, this gets complex! Let me reconsider...

Actually, the current approach captures `state.discount` as a single expression.
Under the hierarchical approach, we'd want to pass just the values we need, not
intermediate objects.

**Two options:**

**Option A:** Pass full nested structure

```typescript
{
  state: {
    pricing: {
      discount: state.pricing.discount;
    }
  }
}
```

Problem: Need to construct nested objects

**Option B:** Keep flat capture names but organize in hierarchy

```typescript
{
  state: {
    pricing_discount: state.pricing.discount;
  }
}
```

Problem: Name doesn't match original (`state.pricing_discount` vs
`state.pricing.discount`)

**Option C:** Pass only what's captured, use path-based names

```typescript
// Schema
state_pricing_discount: { type: "number", asOpaque: true }

// Params
{ state_pricing_discount: state.pricing.discount }

// But callback still references...
state.pricing.discount // How does this resolve?
```

This reveals a fundamental challenge: **how do we make `state.pricing.discount`
work when `state` is a parameter?**

### Solution: Nested Object Construction

We need to actually build nested objects in the params. For
`state.pricing.discount`:

```typescript
{
  state: {
    pricing: {
      discount: state.pricing.discount;
    }
  }
}
```

The schema would define the full nested structure, and TypeScript would
correctly type `state.pricing.discount` as accessible.

## Implementation Complexity Analysis

### What Changes

**File:** `src/closures/transformer.ts`

**Function:** `groupCapturesByRoot()` - NEW

- Parse property access chains to extract root + path
- Group by root identifier
- Build hierarchical structure map

**Function:** `buildParamsProperties()` - MAJOR CHANGE

- Instead of flat list of properties
- Build nested object type structure
- Recursively create property signatures for each level

**Function:** `buildCallbackParamTypeNode()` - MODERATE CHANGE

- Don't use fixed "element", "params" names
- Use original parameter names from callback
- For each captured root, add as top-level property

**Function:** `createRecipeCallWithParams()` - MAJOR CHANGE

- Build hierarchical params object instead of flat
- Parameters: use original names, not `element/params`
- No destructuring of params

**Function:** `replaceCaptures()` - DELETE

- No longer needed! Captures already have correct names

**Function:** `transformElementReferences()` - MINIMAL CHANGE

- Still needed for destructured params
- But use original name, not "element"

### Complexity Rating

- **Capture grouping logic:** MEDIUM (new algorithm for hierarchy)
- **Schema generation:** HIGH (recursive nested object types)
- **Params object construction:** HIGH (recursive nested objects)
- **Body transformation:** LOW (actually simpler - remove code!)
- **Testing:** HIGH (many edge cases to validate)

### Est

imated Implementation Time

- Grouping algorithm: 2-3 hours
- Schema generation refactor: 4-6 hours
- Params construction: 3-4 hours
- Body transformation cleanup: 1-2 hours
- Testing & debugging: 6-8 hours
- **Total: 16-23 hours** (~2-3 days of focused work)

## Benefits vs Costs

### Benefits

1. **Correctness:** Fixes synthetic node symbol resolution bug
2. **Maintainability:** Simpler mental model, less transformation
3. **Debuggability:** Generated code looks more like source
4. **Robustness:** Fewer edge cases in body rewriting

### Costs

1. **Implementation time:** ~2-3 days
2. **Risk:** Complex refactor of core transformation
3. **Testing burden:** Need to update all existing test fixtures
4. **Schema complexity:** Nested object types are harder to reason about

## Recommendation

**IMPLEMENT IT**

The benefits outweigh the costs, especially:

- Fixes current bug with synthetic nodes immediately
- Makes system more maintainable long-term
- Aligns with how developers think about closures
- Reduces transformation complexity overall

The hierarchical approach is more aligned with JavaScript semantics and will be
easier to maintain as the system grows.

## Migration Path

1. Implement hierarchical grouping logic
2. Update schema generation for nested structures
3. Update params object construction
4. Simplify body transformation (remove unnecessary steps)
5. Update all test fixtures with new expected output
6. Test thoroughly with edge cases
7. Deploy and monitor

## Open Questions

1. **Deep nesting:** What's the max nesting depth we support? (Suggest:
   unlimited, but warn if >5)
2. **Name collisions:** What if callback has parameter named same as captured
   root? (Suggest: rename capture root with suffix)
3. **Array index captures:** `items[idx]` - do we capture `items` as object with
   keys? (Suggest: out of scope for v1, keep flat)
4. **Mixed captures:** `state.foo` and `state` both captured - how to handle?
   (Suggest: if root captured, don't nest children)
