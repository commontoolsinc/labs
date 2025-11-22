# Schema Injection - Implementation Notes & Known Issues

This document captures design decisions and concerns about the schema injection implementation, particularly around literal type widening.

## Known Issues & Concerns

### 1. Recursive Schema Merging Feels Brittle

**Location**: `packages/schema-generator/src/formatters/union-formatter.ts` (lines 115-262)

**Problem**: When `widenLiterals: true`, we need to merge structurally identical schemas that differ only in literal enum values. For example:

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
- `mergeIdenticalSchemas()` - Groups schemas by normalized structure (ignoring enum values)
- `normalizeSchemaForComparison()` - Converts schemas to comparable form (enum → base type)
- `mergeSchemaGroup()` - Recursively merges schema groups by widening enums to base types

**Concerns**:
- **Brittle**: Relies on JSON.stringify() for structural comparison, which is fragile
- **Hacky**: Recursively walks and rebuilds schema objects to merge them
- **Incomplete**: Only handles properties, items, required, additionalProperties - might miss edge cases
- **Performance**: Creates many intermediate objects and does O(n²) comparisons

**Why This Approach**:
- TypeScript's type inference creates union types for array literals with different property values
- The top-level `widenLiteralType()` only widens the immediate type, not nested unions
- We need schema-level merging because the Type is already a union by the time it reaches the formatter

**Possible Future Improvements**:
1. Widen the Type earlier in the pipeline (before schema generation)
2. Use a more robust structural equality check (not JSON.stringify)
3. Define a formal schema normalization/merging algorithm
4. Add comprehensive tests for edge cases (nested unions, mixed types, etc.)

---

### 2. Undefined Schema Choice Is Uncertain

**Location**: `packages/schema-generator/src/formatters/primitive-formatter.ts` (lines 90-94)

**Problem**: What JSON Schema should we generate for `cell(undefined)`?

**Current Behavior**: Returns `true` (JSON Schema boolean meaning "accept any value")

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

**Related**: TypeScript itself has ongoing confusion about `null` vs `undefined` semantics in JSON contexts. Our schema generation reflects this ambiguity.

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

---

## Test Coverage

All literal widening scenarios tested in `test/fixtures/schema-injection/`:
- ✅ `literal-widen-number.input.tsx`
- ✅ `literal-widen-string.input.tsx`
- ✅ `literal-widen-boolean.input.tsx`
- ✅ `literal-widen-bigint.input.tsx`
- ✅ `literal-widen-array-elements.input.tsx`
- ✅ `literal-widen-object-properties.input.tsx`
- ✅ `literal-widen-nested-structure.input.tsx` (tests recursive merging)
- ✅ `literal-widen-explicit-type-args.input.tsx` (ensures literals preserved when explicit)
- ✅ `literal-widen-mixed-values.input.tsx`
- ✅ `literal-widen-null-undefined.input.tsx` (documents undefined → `true` behavior)

---

## Future Work

### Priority: High
- [ ] Revisit undefined schema choice based on runtime behavior patterns
- [ ] Add error handling for schema merging edge cases

### Priority: Medium
- [ ] Replace JSON.stringify comparison with proper structural equality
- [ ] Optimize schema merging performance (reduce intermediate objects)
- [ ] Add comprehensive edge case tests (deeply nested unions, mixed union types)

### Priority: Low
- [ ] Consider widening at Type level instead of Schema level
- [ ] Explore alternative union merging strategies
- [ ] Document schema generation algorithm formally

---

**Last Updated**: 2025-01-21
**Implementation**: PR #XXXX (schema injection with literal widening)
