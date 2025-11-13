# Design: Enhanced Union Handling in CommonToolsFormatter

## Problem Statement

When `OpaqueRef<T | undefined>` is encountered, TypeScript's distributive
conditional types expand it to `OpaqueRef<T> | OpaqueRef<undefined>`. The
CommonToolsFormatter currently rejects all union types (line 48-50), delegating
to UnionFormatter. However, UnionFormatter then expands the conditional type
internals of OpaqueRef, leading to unsupported conditional types.

## Design Goals

1. **Detect wrapper-containing unions early** - before conditional type
   expansion
2. **Process wrapper unions** in CommonToolsFormatter using node-based
   extraction
3. **Maintain backward compatibility** - don't break existing union handling
4. **Minimal invasiveness** - reuse existing helper functions
5. **Handle all wrapper types** - Cell, OpaqueRef, Stream, Default

## Architecture

### Detection Strategy

Use **node-based detection** in `supportsType()` to identify unions containing
wrappers:

```typescript
// Detection happens at the TypeNode level (syntactic)
// BEFORE TypeScript expands conditional types

UnionTypeNode: T | undefined
  ├─ TypeReferenceNode: OpaqueRef<T>
  │    └─ TypeArgument: T
  └─ KeywordTypeNode: undefined

// We can inspect the TypeReferenceNode and see "OpaqueRef"
// WITHOUT triggering conditional type expansion
```

### Processing Strategy

When we detect a wrapper union:

1. **Take ownership** - return `true` from `supportsType()`
2. **Process node-by-node** - extract type arguments directly from nodes
3. **Apply wrapper semantics** - add `asOpaque: true` or `asCell: true`
4. **Handle undefined** - filter it out (handled via JSON Schema `required`
   array)
5. **Generate schema** - return single schema or `anyOf` if multiple members
   remain

## Implementation Plan

### Phase 1: Detection Enhancement

**Location**: `CommonToolsFormatter.supportsType()`

**Current logic**:

```typescript
supportsType(type: ts.Type, context: GenerationContext): boolean {
  // Check Default
  // Check Opaque union

  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return false;  // ← PROBLEM: Blanket rejection
  }

  // Check wrapper info
}
```

**New logic**:

```typescript
supportsType(type: ts.Type, context: GenerationContext): boolean {
  // 1. Existing: Check Default via node
  const wrapperViaNode = detectWrapperViaNode(context.typeNode, context.typeChecker);
  if (wrapperViaNode === "Default") {
    return true;
  }

  // 2. Existing: Check Opaque<T> union (T | OpaqueRef<T>)
  if (this.isOpaqueUnion(type, context.typeChecker)) {
    return true;
  }

  // 3. NEW: Check if union contains wrapper types via node inspection
  if (this.isWrapperUnion(type, context)) {
    return true;  // ← Take ownership of wrapper unions
  }

  // 4. Existing: Bail out on other unions
  if ((type.flags & ts.TypeFlags.Union) !== 0) {
    return false;
  }

  // 5. Existing: Check wrapper info via type structure
  const wrapperInfo = getCellWrapperInfo(type, context.typeChecker);
  return wrapperInfo !== undefined;
}
```

### Phase 2: Union Detection Helper

**New method**: `isWrapperUnion()`

```typescript
private isWrapperUnion(type: ts.Type, context: GenerationContext): boolean {
  // Must be a union type
  if ((type.flags & ts.TypeFlags.Union) === 0) {
    return false;
  }

  // Must have a UnionTypeNode to inspect
  if (!context.typeNode || !ts.isUnionTypeNode(context.typeNode)) {
    return false;
  }

  // Check if any member is a wrapper type by examining nodes
  // This avoids triggering conditional type expansion
  const unionNode = context.typeNode;

  return unionNode.types.some(memberNode => {
    // Check if this node represents a wrapper type
    const resolved = resolveWrapperNode(memberNode, context.typeChecker);
    if (resolved) {
      return true;  // Found Cell/OpaqueRef/Stream
    }

    // Also check for Default (which is handled differently)
    const wrapper = detectWrapperViaNode(memberNode, context.typeChecker);
    if (wrapper === "Default") {
      return true;
    }

    return false;
  });
}
```

**Why this works**:

- `resolveWrapperNode()` already exists (type-utils.ts line 82)
- It checks the **node structure** without expanding types
- Returns wrapper info if it's a Cell/OpaqueRef/Stream reference

### Phase 3: Union Formatting

**Location**: `CommonToolsFormatter.formatType()`

**Insert at the beginning** (before existing logic):

```typescript
formatType(type: ts.Type, context: GenerationContext): SchemaDefinition {
  const n = context.typeNode;

  // NEW: Handle wrapper unions first
  if ((type.flags & ts.TypeFlags.Union) !== 0 && this.isWrapperUnion(type, context)) {
    return this.formatWrapperUnion(type as ts.UnionType, context);
  }

  // EXISTING: Check for Opaque<T> union...
  const opaqueUnionInfo = this.getOpaqueUnionInfo(type, context.typeChecker);
  // ... rest of existing logic
}
```

### Phase 4: Wrapper Union Formatter

**New method**: `formatWrapperUnion()`

```typescript
private formatWrapperUnion(
  unionType: ts.UnionType,
  context: GenerationContext,
): SchemaDefinition {
  const unionNode = context.typeNode as ts.UnionTypeNode;
  const members = unionType.types;

  // Filter out undefined (handled via JSON Schema required array)
  const nonUndefined = members.filter(
    (m) => (m.flags & ts.TypeFlags.Undefined) === 0
  );

  // Process each non-undefined member
  const schemas: SchemaDefinition[] = [];

  for (let i = 0; i < members.length; i++) {
    const memberType = members[i];
    const memberNode = unionNode.types[i];

    // Skip undefined
    if ((memberType.flags & ts.TypeFlags.Undefined) !== 0) {
      continue;
    }

    // Check if this member is a wrapper type
    const wrapperInfo = resolveWrapperNode(memberNode, context.typeChecker);

    if (wrapperInfo) {
      // Extract the inner type from the wrapper WITHOUT expanding conditionals
      const schema = this.formatWrapperMember(
        memberType,
        memberNode,
        wrapperInfo,
        context,
      );
      schemas.push(schema);
    } else {
      // Not a wrapper - use standard formatting
      const schema = this.schemaGenerator.formatChildType(
        memberType,
        context,
        memberNode,
      );
      schemas.push(schema);
    }
  }

  // Return single schema or anyOf
  if (schemas.length === 0) {
    // All members were undefined - return true (any value)
    return true as SchemaDefinition;
  } else if (schemas.length === 1) {
    return schemas[0];
  } else {
    return { anyOf: schemas };
  }
}
```

### Phase 5: Wrapper Member Formatter

**New method**: `formatWrapperMember()`

```typescript
private formatWrapperMember(
  memberType: ts.Type,
  memberNode: ts.TypeNode,
  wrapperInfo: { kind: string; node: ts.TypeReferenceNode },
  context: GenerationContext,
): SchemaDefinition {
  // Extract type arguments from the node (avoids conditional expansion)
  const wrapperNode = wrapperInfo.node;

  if (!ts.isTypeReferenceNode(wrapperNode)) {
    // Fallback - shouldn't happen based on wrapperInfo contract
    throw new Error("Expected TypeReferenceNode for wrapper");
  }

  const typeArgs = wrapperNode.typeArguments;

  if (!typeArgs || typeArgs.length === 0) {
    // Wrapper with no type arguments - treat as any
    return { asOpaque: true }; // Or asCell depending on kind
  }

  // Get the inner type from the first type argument
  const innerTypeNode = typeArgs[0];
  const innerType = context.typeChecker.getTypeFromTypeNode(innerTypeNode);

  // Format the inner type
  const innerSchema = this.schemaGenerator.formatChildType(
    innerType,
    context,
    innerTypeNode,
  );

  // Apply wrapper semantics based on kind
  if (typeof innerSchema === "boolean") {
    // Boolean schemas can't have additional properties
    return innerSchema;
  }

  switch (wrapperInfo.kind) {
    case "OpaqueRef":
      return { ...innerSchema, asOpaque: true };
    case "Cell":
      return { ...innerSchema, asCell: true };
    case "Stream":
      return { ...innerSchema, asStream: true };
    default:
      return innerSchema;
  }
}
```

## Edge Cases & Handling

### Case 1: `OpaqueRef<T> | OpaqueRef<U>`

- Both members are wrappers
- Process each, add `asOpaque: true` to both
- Return `{ anyOf: [schema1, schema2] }`

### Case 2: `OpaqueRef<T> | undefined`

- Filter out undefined
- Return single schema with `asOpaque: true`

### Case 3: `OpaqueRef<T> | string`

- Mixed wrapper and non-wrapper
- Process OpaqueRef with extraction
- Process string normally
- Return `{ anyOf: [...] }`

### Case 4: `Cell<T> | OpaqueRef<U>`

- Different wrapper types in same union
- Each gets appropriate marker (`asCell`, `asOpaque`)
- Return `{ anyOf: [...] }`

### Case 5: Deeply nested: `OpaqueRef<T | undefined>`

**This is the problematic case!**

After distributive conditional expansion:

```typescript
OpaqueRef<T | undefined> → OpaqueRef<T> | OpaqueRef<undefined>
```

Our solution:

- Detect the union at the node level: `UnionTypeNode` with two
  `TypeReferenceNode` children
- Extract `T` from first `OpaqueRef<T>` via node's type arguments
- Extract `undefined` from second - skip it
- Never expand the OpaqueRef conditional internals!

### Case 6: `Default<T, V> | undefined`

- Default is already handled via `detectWrapperViaNode`
- Should continue to work
- Union handling adds support for Default in unions

## Integration Points

### Existing Functions to Reuse

1. **`resolveWrapperNode()`** (type-utils.ts)
   - Already detects Cell/OpaqueRef/Stream via node inspection
   - Returns `{ kind, node }` or undefined

2. **`detectWrapperViaNode()`** (type-utils.ts)
   - Handles Default detection
   - Returns wrapper kind or undefined

3. **`formatChildType()`** (schema-generator.ts)
   - Recursively formats inner types
   - Pass the node to preserve context

### New Helper Functions

1. **`isWrapperUnion()`** - Detection
2. **`formatWrapperUnion()`** - Top-level union processing
3. **`formatWrapperMember()`** - Individual member processing

## Testing Strategy

### Unit Tests (add to common-tools-formatter.test.ts)

```typescript
describe("wrapper union handling", () => {
  it("should handle OpaqueRef<T> | undefined", () => {
    // Input: wish<{ allCharms: T[] }>("/")
    // Expected: schema for T[] with asOpaque: true
  });

  it("should handle Cell<T> | undefined", () => {
    // Input: cell<number> | undefined
    // Expected: { type: "number", asCell: true }
  });

  it("should handle mixed OpaqueRef<T> | string", () => {
    // Expected: { anyOf: [{ ...T, asOpaque: true }, { type: "string" }] }
  });

  it("should handle nested OpaqueRef<T | undefined>", () => {
    // The distributive expansion case
    // Expected: correct schema without conditional type expansion
  });
});
```

### Integration Test

Add to `wish.test.ts` or create new test file:

```typescript
it("should compile patterns with wish type parameters", async () => {
  const pattern = `
    const { allCharms } = wish<{ allCharms: MentionableCharm[] }>("/");
  `;

  // Should compile without "No formatter found" error
  await expect(compilePattern(pattern)).resolves.not.toThrow();
});
```

## Risks & Mitigations

### Risk 1: Breaking Existing Union Handling

**Mitigation**: Only take ownership when `isWrapperUnion()` returns true.
Existing non-wrapper unions continue to UnionFormatter.

### Risk 2: Incomplete Type Argument Extraction

**Mitigation**: Validate that `wrapperNode.typeArguments` exists. Fallback to
treating as `any` schema if missing.

### Risk 3: Nested Wrappers (e.g., `OpaqueRef<Cell<T>>`)

**Mitigation**: Recursive `formatChildType()` will handle nested wrappers
naturally since we're only extracting the first layer.

### Risk 4: Performance Impact

**Mitigation**: `isWrapperUnion()` is only called for union types, and node
inspection is fast (no type expansion).

## Success Criteria

1. ✅ `deno task ct dev --show-transformed packages/patterns/default-app.tsx`
   completes without error
2. ✅ All existing schema-generator tests pass
3. ✅ New tests for wrapper unions pass
4. ✅ No regression in build times
5. ✅ Clean type check (`deno task check`)

## Implementation Order

1. Add `isWrapperUnion()` helper method
2. Update `supportsType()` to check for wrapper unions
3. Add `formatWrapperUnion()` method
4. Add `formatWrapperMember()` method
5. Update `formatType()` to handle wrapper unions early
6. Add unit tests
7. Test with `default-app.tsx`
8. Add integration test

---

**Ready to proceed with implementation?** This design should give us a robust
solution that handles the current issue and future edge cases.
