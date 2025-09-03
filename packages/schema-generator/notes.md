# Schema Generator Notes

## Type System Architecture

### SchemaDefinition vs JSONSchema

**Current State:**
- `SchemaDefinition` (schema-generator): Internal working type, simplified JSON Schema subset, mutable, includes `[key: string]: any` for flexibility
- `JSONSchema` (packages/api): Complete JSON Schema Draft-07 spec, immutable with `readonly`, explicitly includes Common Tools extensions (`asCell?: boolean`, `asStream?: boolean`)

**The Type Alignment Issue:**
Both old and new systems return `any` from schema generators and rely on compile-time `satisfies JSONSchema` assertions injected by the AST transformer. Type safety comes from the transformer's promise that generated objects will satisfy JSONSchema, not from strong typing during generation.

**How it worked:**
```typescript
// Developer writes:
toSchema<State>()

// Transformer converts to:
{
  type: "object", 
  properties: { 
    count: { type: "number", asCell: true }  // ✅ asCell is explicitly defined in JSONSchema
  }
} as const satisfies JSONSchema
```

**Key insight:** The CommonTools `JSONSchema` type was designed from the start to support `asCell`/`asStream` extensions as explicit optional properties, not via an index signature escape hatch. No type system workarounds were needed.

---

## Open Questions

**🤔 Type System Strategy Decision Needed:**

Should we invest in aligning the type systems as mentioned in refactor_plan.md lines 184-193?

**Option A: Status Quo**
- Keep returning `any` from generators
- Maintain current transformer-based type safety
- ✅ Works, matches old system, no breaking changes
- ❌ Loose internal typing, defers type safety to runtime

**Option B: Strong Internal Typing** 
- Create proper SchemaDefinition → JSONSchema conversion
- Strongly type generator return values to return actual `JSONSchema` objects
- ✅ Better developer experience, catch bugs earlier, eliminate `any` returns
- ❌ Significant refactoring, potential breaking changes
- ❌ Note: ExtendedJSONSchema is not needed - `asCell`/`asStream` are already in `JSONSchema`

**Questions for Manager:**
1. Is type safety debt worth addressing now or defer to future iteration?
2. Should we prioritize shipping the current refactor vs. perfecting the type system?
3. Are there concrete pain points from the current `any`-based approach?

---

## Implementation Notes

### Cycle Detection
Removed all depth-based tracking (lines 200+ in formatType, depth params, maxDepth context) in favor of precise identity-based cycle detection using `definitionStack`, `inProgressNames`, and pre-computed `cyclicTypes` sets.

### Formatter Chain
- CommonToolsFormatter: Cell<T>, Stream<T>, Default<T,V>
- UnionFormatter: Union types and literal unions  
- IntersectionFormatter: A & B merging
- ArrayFormatter: Array<T>, T[], ReadonlyArray<T>
- PrimitiveFormatter: string, number, boolean, etc.
- ObjectFormatter: Interfaces, type literals

### Test Strategy
Moving toward fixture-based testing with canonical JSON Schema output comparison for stability guarantees.