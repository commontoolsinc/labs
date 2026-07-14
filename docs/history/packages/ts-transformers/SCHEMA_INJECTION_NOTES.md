---
status: historical
created: 2025-11-26
archived: 2026-07-08
reason: "Working notes from the schema-injection work."
---

# Schema Injection - Implementation Notes & Known Issues

This document captures design decisions and concerns about the schema injection
implementation, particularly around literal type widening.

## Known Issues & Concerns

### 1. Recursive Schema Merging Feels Brittle

**Location**: `packages/schema-generator/src/formatters/union-formatter.ts`
(lines 115-262)

**Problem**: When `widenLiterals: true`, we need to merge structurally identical
schemas that differ only in literal enum values. For example:

```typescript
// TypeScript infers this as a union of two object types:
[{active: true}, {active: false}]
// Type: Array<{active: true} | {active: false}>

// We want this schema:
{
  type: "array",
  items: {
    type: "object",
    properties: {
      active: { type: "boolean" }  // ← merged, not anyOf
    }
  }
}
```

**Current Implementation**:

- `mergeIdenticalSchemas()` - Groups schemas by normalized structure (ignoring
  enum values)
- `normalizeSchemaForComparison()` - Converts schemas to comparable form (enum →
  base type)
- `mergeSchemaGroup()` - Recursively merges schema groups by widening enums to
  base types

**Concerns**:

- **Brittle**: Relies on JSON.stringify() for structural comparison, which is
  fragile
- **Hacky**: Recursively walks and rebuilds schema objects to merge them
- **Incomplete**: Only handles properties, items, required,
  additionalProperties - might miss edge cases
- **Performance**: Creates many intermediate objects and does O(n²) comparisons

**Why This Approach**:

- TypeScript's type inference creates union types for array literals with
  different property values
- The top-level `widenLiteralType()` only widens the immediate type, not nested
  unions
- We need schema-level merging because the Type is already a union by the time
  it reaches the formatter

**Possible Future Improvements**:

1. Widen the Type earlier in the pipeline (before schema generation)
2. Use a more robust structural equality check (not JSON.stringify)
3. Define a formal schema normalization/merging algorithm
4. Add comprehensive tests for edge cases (nested unions, mixed types, etc.)

---

### 2. Undefined Schema Choice Is Uncertain

**Location**: `packages/schema-generator/src/formatters/primitive-formatter.ts`
(lines 90-94)

**Problem**: What JSON Schema should we generate for `cell(undefined)`?

**Current Behavior**: Returns `true` (JSON Schema boolean meaning "accept any
value")

```typescript
const c = cell(undefined);
// Generates: cell(undefined, true as const satisfies JSONSchema)
```

**Why `true` Is Questionable**:

- `undefined` is not a valid JSON value (serializes to `null` or is omitted)
- `true` means "no validation" - everything passes
- Doesn't reflect what actually happens at runtime

**Alternative Options Considered**:

1. **`{ type: "null" }`** - Treat undefined same as null
   - Pro: Matches JSON serialization behavior
   - Con: Loses semantic distinction between explicit null and undefined

2. **Skip schema injection** - Don't inject schema for undefined at all
   - Pro: Acknowledges undefined isn't JSON-serializable
   - Con: Inconsistent - some cells have schemas, others don't

3. **`true` (current)** - Accept any value
   - Pro: Won't reject values at runtime (permissive)
   - Con: Provides no validation benefit

4. **`{}`** - Empty schema object (equivalent to `true`)
   - Pro: Semantically similar but object form
   - Con: Still provides no validation

**Decision**: Use `true` for now

- Rationale: Permissive approach won't cause runtime rejection issues
- Trade-off: No validation benefit, but avoids breaking things
- Future: May need to revisit based on real-world usage patterns

**Related**: TypeScript itself has ongoing confusion about `null` vs `undefined`
semantics in JSON contexts. Our schema generation reflects this ambiguity.

---

### 3. Empty Collections Schema Generation Is Questionable

**Location**: Schema generation for empty arrays and objects

**Test Case**: `test/fixtures/schema-injection/collections-empty.input.tsx`

**Problem**: What schemas should we generate for empty collections where
TypeScript can't infer contents?

**Current Behavior**:

```typescript
const arr = cell([]);
// Generates: cell([], { type: "array", items: false })
// TypeScript infers: never[] (array that can contain nothing)

const obj = cell({});
// Generates: cell({}, { type: "object", properties: {} })
// TypeScript infers: {} (object with no known properties)
```

**Why This Is Questionable**:

- **Empty arrays**: `items: false` (JSON Schema boolean) means "no items
  allowed" - very restrictive
  - Accurately reflects `never[]` but may not match user intent
  - If the array is meant to be populated later, this schema is wrong

- **Empty objects**: `properties: {}` with no `required` allows any properties
  - More permissive than the array case
  - May or may not match user intent

**Alternative Options**:

1. **Skip schema injection** - Don't inject schemas for empty collections
   - Pro: Acknowledges we have no useful type information
   - Con: Inconsistent - some cells get schemas, others don't
   - Con: User has to manually add schema if they want one

2. **Use permissive schemas** - `{ type: "array" }` and `{ type: "object" }`
   - Pro: Won't reject valid data at runtime
   - Con: Provides minimal validation benefit
   - Con: Doesn't reflect what TypeScript actually knows

3. **Keep current behavior** - Generate schemas from inferred types (current)
   - Pro: Consistent with "generate what TypeScript knows"
   - Pro: `never[]` actually means "empty forever"
   - Con: May surprise users who expect mutable arrays

**Decision**: Keep current behavior (Option 3)

- Rationale: Consistency with our principle of reflecting TypeScript's type
  knowledge
- If users want permissive or different schemas, they should use explicit type
  arguments:
  - `cell<number[]>([])` → generates
    `{ type: "array", items: { type: "number" } }`
  - `cell<{x?: number}>({})` → generates schema for that type
- The generated schemas accurately reflect what TypeScript infers

**Related**: This is similar to Issue 2 (undefined) - we generate schemas based
on TypeScript's understanding, even when that might not match user expectations.

---

## Design Decisions

### Literal Widening Strategy

**When widening happens**:

- ✅ **Value inference path**: `cell(10)` → widens 10 to number
- ❌ **Explicit type args path**: `cell<10>(10)` → preserves literal type 10

**How widening is triggered**:

1. `schema-injection.ts` detects value inference (no explicit type arg)
2. Passes `{ widenLiterals: true }` option through `toSchema()` call
3. `schema-generator.ts` extracts option and passes to schema generator
4. `GenerationContext.widenLiterals` flag propagates to all formatters
5. Formatters check flag and widen literals when set

**Affected types**:

- Number literals: `10` → `number`
- String literals: `"hello"` → `string`
- Boolean literals: `true`/`false` → `boolean`
- BigInt literals: `10n` → `bigint` (integer in JSON Schema)
- Nested literals: Recursively widened through union merging

### Imported Cell Parameters Are a Capability Contract

Capability analysis decides how a handler input cell is shrunk. Body analysis
can see reads and direct writes (`auth.update(...)`), but it cannot see what a
callee does inside a body that lives in another file. When a handler passes a
cell to such a callee, the callee's declared Common Fabric wrapper parameter
type is the capability contract at that import boundary, and it accounts for
that argument at that call.

A recognized wrapper parameter type maps to a capability: `Writable<T>` → read
and write, `ReadonlyCell<T>` → read, `WriteonlyCell<T>` → write, and the
opaque/stream/comparable/sqlite wrappers to their respective handling.
`Writable<T>` is a _structural_ alias of `Cell<T>` — an identical type — so
those two are distinguished only by the spelling on the declared type node; the
transformer's matching is what is nominal (by name). Bare `Cell<T>` and
same-named types from other libraries are not recognized and leave the
conservative default in place; unknown callees stay conservative.

The other wrappers carry distinct compile-time brands, so they are genuinely
different types, not just different spellings. In particular a `Writable<T>`
value is not assignable to a `ReadonlyCell<T>` parameter — that is a `TS2345`
error (the `[CELL_BRAND]` tags `"cell"` and `"readonly"` are incompatible). So
the `ReadonlyCell<T>` → readonly shrink is reached when a handler's own input is
declared `ReadonlyCell<T>`, or through an explicit cast; a writable cell cannot
be passed to a read-only parameter directly. This is why granting write is the
only direction the contract needs to relax the least-authority default — the
type system already prevents the read-only direction from silently discarding a
writable cell.

Why the declared type is the right contract, and why it is trusted in both
directions: the schema this analysis produces is what the runtime enforces. Per
spec 8.15, a field's `writeAuthorizedBy` set is composed from the handlers that
declare they write it, and `authorizeWrite` allows a runtime write only when the
handler identity is in that set. The threat model (spec 9.1.1, 9.2.2) treats
handler code as untrusted and able to attempt privilege escalation. So the
analysis derives least authority: it grants write only where a write is
demonstrated, and passing a cell to a declared reader demonstrates no write.
Preserving write authority a handler does not use would broaden
`writeAuthorizedBy` and weaken least authority; a cast that tries to write past
a declared read-only type is denied at runtime because the schema, not the cast,
is enforced. Trusting the declared type to reduce authority is therefore safe,
and trusting it to grant write is bounded by the caller's own declaration and is
what real refresh clients need.

A recognized wrapper accounts for its argument: it replaces the conservative
whole-cell root fallback for that specific argument and call, and it does not
erase other evidence found elsewhere in the handler (a direct `auth.update(...)`
still contributes a write). A provider client whose factory accepts both a live
cell and a read-only wrapper should expose them as separate overloads
(`Writable<T>` and the wrapper type) rather than a single union parameter, so
overload resolution selects the writable form only for a live cell. See
`GmailSendClient` for the pattern.

Authoring rule: an imported function or constructor that writes a cell argument
must declare that parameter `Writable<T>` (or `WriteonlyCell<T>`). Declaring it
`ReadonlyCell<T>` shrinks callers' schemas to read-only and their writes are
denied at runtime — the honest fix is the declared type, not broader authority
in the caller.

### Diagnostic for ambiguous cell-union parameters

Most unclassifiable parameter shapes degrade conservatively and are safe or are
legitimate framework types, so they are left alone. One shape is a genuine
authoring bug: a union parameter that mixes a recognized cell wrapper with a
member the contract cannot resolve to the same capability — for example
`AuthCell | Writable<Auth>`, or `Writable<Auth> | ReadonlyCell<Auth>`. Overload
resolution cannot pick the capability, so a cell argument silently degrades.
When a branded cell argument flows to such a parameter, capability analysis
records it and the schema-injection transformer raises a
`capability:unreadable-cell-argument` error telling the author to split the
callee into overloads (the fix `GmailSendClient` already applies). This makes
the split-overload rule fail loudly rather than by convention.

The diagnostic is deliberately narrow, and only fires for the mixed-wrapper
union. It does **not** fire for value-or-cell framework types
(`FactoryInput<T>`, `CellLike<T>`, `U | AnyBrandedCell<U>`), which accept a
value or a cell by design and are either not unions or unions with no
recognized-wrapper member; nor for bare `Cell<T>`, generic parameters,
structural cell-like interfaces on their own, array identity-writer methods, or
`any`/`unknown` sinks. A sweep of the pattern corpus confirmed zero matches for
anything but the true overload-split shape.

---

## Test Coverage

### Completed Tests (18 fixtures in `test/fixtures/schema-injection/`)

**Literal Type Widening:**

- ✅ `literal-widen-number.input.tsx`
- ✅ `literal-widen-string.input.tsx`
- ✅ `literal-widen-boolean.input.tsx`
- ✅ `literal-widen-bigint.input.tsx`
- ✅ `literal-widen-array-elements.input.tsx`
- ✅ `literal-widen-object-properties.input.tsx`
- ✅ `literal-widen-nested-structure.input.tsx` (tests recursive merging)
- ✅ `literal-widen-explicit-type-args.input.tsx` (ensures literals preserved
  when explicit)
- ✅ `literal-widen-mixed-values.input.tsx`
- ✅ `literal-widen-null-undefined.input.tsx` (documents undefined → `true`
  behavior)

**Double-Injection Prevention:**

- ✅ `double-inject-already-has-schema.input.tsx` - Cells with existing schemas
  aren't transformed
- ✅ `double-inject-wrong-position.input.tsx` - Malformed code isn't made worse
- ✅ `double-inject-extra-args.input.tsx` - Cells with >2 arguments aren't
  transformed

**Context Variations:**

- ✅ `context-variations.input.tsx` - Tests cell() in 6 scopes (top-level,
  function, arrow function, class method, pattern, handler)

**Cell-like Classes:**

- ✅ `cell-like-classes.input.tsx` - Tests all cell variants (cell,
  ComparableCell, ReadonlyCell, WriteonlyCell)

**Collection Edge Cases:**

- ✅ `collections-empty.input.tsx` - Empty arrays and objects (see Issue #3)
- ✅ `collections-nested-objects.input.tsx` - Deeply nested object literal
  widening
- ✅ `collections-array-of-objects.input.tsx` - Arrays of objects with literal
  properties

### Remaining Tests to Add

**Priority 2: Schema Merging Edge Cases** (addresses "brittle" code in Issue #1)

- [ ] `collections-deeply-nested-unions` - 3+ levels of nested union merging
  ```typescript
  const data = cell([
    { user: { profile: { settings: { theme: "dark", notifications: true } } } },
    {
      user: { profile: { settings: { theme: "light", notifications: false } } },
    },
  ]);
  ```
- [ ] `collections-mixed-union-types` - Unions with different structural types
  ```typescript
  const mixed = cell([
    { type: "user", name: "Alice", age: 30 },
    { type: "admin", name: "Bob", role: "superuser" },
  ]);
  ```
- [ ] `collections-array-length-variations` - Arrays with varying element counts
- [ ] `optional-properties` - Objects with optional properties
- [ ] `partial-types` - Test Partial<T> and similar utility types

**Priority 3: Additional Runtime Functions**

- [ ] `pattern-variations` - Comprehensive pattern() testing (with/without
      schema)
- [ ] `handler-variations` - Comprehensive handler() testing (with/without
      schema)
- [ ] `wish-function` - Test wish() schema injection
- [ ] `stream-class` - Test Stream class (remaining Cell-like class)

**Priority 4: Complex TypeScript Features**

- [ ] `generic-types` - Generic type parameters
- [ ] `intersection-types` - Type intersections (A & B)
- [ ] `tuple-types` - Tuple types vs arrays
- [ ] `enum-types` - TypeScript enums

**Priority 5: Error Cases**

- [ ] `circular-references` - Objects with circular references
- [ ] `invalid-json-types` - Non-JSON-serializable types (functions, symbols)

**Recommendation**: Implement Priority 2 tests next, especially the schema
merging edge cases, as they directly test the code identified as brittle in
Issue #1.

---

## Future Work

### Priority: High

- [ ] Revisit undefined schema choice based on runtime behavior patterns
- [ ] Add error handling for schema merging edge cases

### Priority: Medium

- [ ] Replace JSON.stringify comparison with proper structural equality
- [ ] Optimize schema merging performance (reduce intermediate objects)
- [ ] Add comprehensive edge case tests (deeply nested unions, mixed union
      types)

### Priority: Low

- [ ] Consider widening at Type level instead of Schema level
- [ ] Explore alternative union merging strategies
- [ ] Document schema generation algorithm formally

---

**Last Updated**: 2025-01-22 **Implementation**: Schema injection with literal
widening (feat/more-schemas-injected branch)
