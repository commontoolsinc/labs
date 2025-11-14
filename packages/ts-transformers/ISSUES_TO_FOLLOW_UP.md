# Issues to Follow Up

This document tracks issues noticed during test expectation updates for the Cell preservation fix.

## 1. Result Schema Falls Back to `true` for Array Element Access

**File:** `test/fixtures/jsx-expressions/element-access-both-opaque.expected.tsx`

**Issue:** When deriving `items[index]` where `items` is `Cell<string[]>` and `index` is `Cell<number>`, the result schema is `true` instead of a proper schema.

**Current behavior:**
```typescript
__ctHelpers.derive({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: { type: "string" },
            asCell: true
        },
        index: {
            type: "number",
            asCell: true
        }
    },
    required: ["items", "index"]
} as const satisfies __ctHelpers.JSONSchema,
true as const satisfies __ctHelpers.JSONSchema,  // ← Falls back to `true`
{
    items: items,
    index: index
}, ({ items, index }) => items[index])
```

**Expected behavior:** The result schema should probably be:
```typescript
{
    type: "string"
}
```

**Root cause:** The expression `items[index]` has type `string | undefined` (because array access can be out of bounds). The type inference may not be able to create a proper schema for union types with undefined, so it falls back to `true`.

**Next steps:** Investigate whether we can improve result type schema generation for:
- Array element access expressions
- Union types that include undefined
- Optional/nullable types

---

## 2. Property Chain Access Does Not Mark Leaf Properties as `asOpaque`

**File:** `test/fixtures/jsx-expressions/jsx-complex-mixed.expected.tsx`

**Issue:** When accessing properties through a chain (e.g., `state.filter.length`), the leaf property gets a plain type without `asOpaque: true`.

**Current behavior:**
```typescript
// Input:
{state.filter.length > 0}

// Generated schema:
__ctHelpers.derive({
  type: "object",
  properties: {
    state: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          properties: {
            length: {
              type: "number"  // ❌ Leaf property has NO asOpaque flag
            }
          },
          required: ["length"]
        }
      },
      required: ["filter"]
    }
  },
  required: ["state"]
}, ...)
```

**Contrast with direct access:**
```typescript
// Direct state property access:
{state.filter}

// Schema:
{
  filter: {
    type: "string",
    asOpaque: true  // ✅ Direct state properties ARE marked as opaque
  }
}
```

**Question to resolve:** Should leaf properties in a property chain also have `asOpaque: true`?

**Arguments for current behavior:**
- The leaf value (`length`) is not itself an OpaqueRef - it's a plain number property
- At runtime: `state.filter` unwraps to a string, then `.length` returns a plain number
- The schema accurately reflects that the final value is plain, not wrapped

**Arguments for marking as opaque:**
- The value still comes from state, which is reactive
- Consistency with how other state-derived values are marked
- May be needed for runtime tracking/reactivity

**Next steps:** Discuss with team whether this is correct or needs to be changed.

---

## 3. Boolean Schema Behavior is Inconsistent and Confusing

**File:** `test/fixtures/jsx-expressions/jsx-conditional-rendering.expected.tsx`

**Issue:** Boolean values and expressions generate different schema patterns depending on context, and it's unclear why.

**Observed patterns:**

1. **Simple boolean state properties used directly in conditions:** Plain `type: "boolean"`
   ```typescript
   // Input: {state.isActive ? "Active" : "Inactive"}
   // No derive needed - isActive used directly
   ```

2. **Boolean state properties captured in complex expressions:** `anyOf` with separate `true`/`false` enums
   ```typescript
   // Input: state.isPremium ? "Premium" : "Regular"
   // Schema:
   {
     isPremium: {
       anyOf: [{
         type: "boolean",
         enum: [false],
         asOpaque: true
       }, {
         type: "boolean",
         enum: [true],
         asOpaque: true
       }]
     }
   }
   ```

3. **Boolean AND expression results:** `anyOf` with `true`/`false` enums
   ```typescript
   // Input: state.isActive && state.hasPermission
   // Result schema:
   {
     anyOf: [{
       type: "boolean",
       enum: [false],
       asOpaque: true
     }, {
       type: "boolean",
       enum: [true],
       asOpaque: true
     }]
   }
   ```

4. **Boolean OR expression results:** Plain `type: "boolean"`
   ```typescript
   // Input: state.isPremium || state.score > 100
   // Result schema:
   {
     type: "boolean"  // ← Why no anyOf here?
   }
   ```

5. **Boolean comparison results:** Plain `type: "boolean"`
   ```typescript
   // Input: state.count > 10
   // Result schema:
   {
     type: "boolean"
   }
   ```

**Questions to resolve:**
- Why do `&&` expressions get `anyOf` but `||` expressions get plain `type: "boolean"`?
- Why do boolean state captures sometimes get `anyOf` and sometimes not?
- Is the `anyOf` pattern actually necessary, or could we use plain `type: "boolean"` everywhere?
- What's the semantic difference between `anyOf` with boolean enums vs plain boolean type?
- Is this TypeScript's literal type narrowing being reflected in schemas?

**Hypothesis:**
The `anyOf` pattern might be TypeScript's way of representing boolean literal types (`true` | `false`) as distinct from the generic `boolean` type. The `&&` operator might be preserving literal types while `||` widens to `boolean`. But this needs verification.

**Next steps:**
- Understand the semantic meaning of these schema patterns
- Determine if the inconsistency is intentional or a bug
- Document the rules for when each pattern should be used

---

## 4. JSX Stored in Derives Now Emits the Entire Render-Node Schema

**Files:**  
`test/fixtures/jsx-expressions/map-array-length-conditional.input.tsx`  
`test/fixtures/jsx-expressions/map-array-length-conditional.expected.tsx`  
`test/fixtures/jsx-expressions/map-nested-conditional.expected.tsx`

**What changed:** With the OpaqueRef JSX transformer running before schema injection, the injector now understands that expressions like `list.length > 0 && (<div>…</div>)` return `false | VNode`. Every derive that wraps JSX now emits a full JSON schema for the render-node union, including `$defs.Element`, `$defs.VNode`, `$defs.RenderNode`, and `$defs.Props`. Example:

```tsx
// Input
{list.length > 0 && (
  <div>
    {list.map((name) => <span>{name}</span>)}
  </div>
)}

// Expected output
__ctHelpers.derive({
  type: "object",
  properties: {
    list: {
      type: "array",
      items: { type: "string" },
      asCell: true
    }
  },
  required: ["list"]
} as const satisfies __ctHelpers.JSONSchema, {
  anyOf: [
    { type: "boolean", enum: [false] },
    { $ref: "#/$defs/Element" }
  ],
  $defs: {
    Element: { /* vnode schema */ },
    VNode:   { /* vnode schema */ },
    RenderNode: { /* recursive union */ },
    Props: { /* prop map */ }
  }
} as const satisfies __ctHelpers.JSONSchema, { list }, ({ list }) =>
  list.length > 0 && (<div>…</div>)
)
```

The same boilerplate now appears in `map-nested-conditional.expected.tsx` where we map over cell values and render nested `<div><span/></div>` trees.

**Where the schema comes from:** The `$defs` block is the JSON-schema translation of our runtime `VNode`/`RenderNode` types from `@commontools/html`. Type inference infers the derive return type (`false | VNode`), and schema injection faithfully emits that structure.

**Questions for management:**

1. Is this level of schema detail desirable in fixtures, or should we collapse it to a shared alias/reference? Each guarded JSX expression now adds ~100 lines of output that obscure the interesting differences.
2. If the detail is necessary, can we document that decision so the verbosity doesn’t raise red flags during review?
3. Alternatively, should schema injection skip result schemas when it’s the standard render-node shape to keep fixtures readable?

**Next steps:** Await guidance before updating the remaining fixtures. Depending on the answer we will either:
- proceed with the verbose schemas,
- or prototype a shared `$ref`/alias (e.g., `#/RenderNode`) to keep expectations manageable,
- or adjust the injector to elide the schema when appropriate.

## 5. `map` in map-array-length-conditional Isn’t Transformed to mapWithPattern

**Files:**
`test/fixtures/jsx-expressions/map-array-length-conditional.input.tsx`
`test/fixtures/jsx-expressions/map-array-length-conditional.expected.tsx`

**Observation:** Even after the pipeline changes, the fixture still shows `list.map((name) => <span>{name}</span>)` inside the derive, rather than our `mapWithPattern` helper that carries explicit schemas. Other fixtures (e.g., `method-chains`) now use `mapWithPattern` for similar patterns.

**Open question:** Is this intentional (because the map result is directly wrapped by JSX and doesn’t need the closure transform), or is the map transformer failing to recognize this scenario now that the schema injector runs later? It feels like we’d still want `mapWithPattern` here for consistency and to keep closures typed.

**Next steps:** Investigate why the closure transformer skips this case and confirm with the team whether the current behavior is correct.
