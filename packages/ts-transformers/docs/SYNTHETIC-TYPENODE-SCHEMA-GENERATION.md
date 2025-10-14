# Synthetic TypeNode Schema Generation Issue

## Problem Statement

When the closure transformer creates synthetic TypeNodes for recipe callback
parameters, schema generation fails to properly handle `$refs` and `$defs`. Each
property's schema is generated in isolation, causing definitions to be lost.

## Root Cause Analysis

### The Flow

1. Closure transformer creates synthetic TypeLiterals via
   `factory.createTypeLiteralNode()`
2. These synthetic nodes don't have source positions (`pos === -1, end === -1`)
3. TypeChecker returns `any` when trying to resolve them
4. Schema transformer detects this and calls `analyzeTypeNodeStructure()` as
   fallback
5. `analyzeTypeNodeStructure` iterates properties and calls
   `generateSchema(propType, checker, member.type, false)` for each
6. **Problem**: Each `generateSchema()` call creates a fresh, isolated context
7. Any `$refs` generated point to `#/$defs/Item` but the definitions are
   discarded
8. Result: Orphaned `$refs` with no `$defs` section OR unwanted `$schema` on
   property schemas

### Why This Happens

The `analyzeTypeNodeStructure` function is architecturally isolated:

- It's a standalone function in the transformer (not part of SchemaGenerator)
- It has no access to schema generation context
- It calls `generateSchema()` which is the **root schema generation entry
  point**
- Each call creates and discards a context

Compare to the normal path (`ObjectFormatter`):

- Uses `schemaGenerator.formatChildType()` for properties
- `formatChildType()` shares the same context across all properties
- Definitions accumulate in `context.definitions`
- `buildFinalSchema()` adds `$schema` and `$defs` at the root

### The TypeRegistry Bridge

The closure transformer registers synthetic TypeNode → Type mappings in
`typeRegistry`:

```typescript
// In closure transformer
typeRegistry.set(syntheticTypeNode, actualType);

// In analyzeTypeNodeStructure
if (typeRegistry && typeRegistry.has(member.type)) {
  propType = typeRegistry.get(member.type);
  propSchema = generateSchema(propType, checker, member.type, false);
}
```

This bridge allows properties to use real Type information, but the context
isolation prevents proper `$refs` and `$defs` handling.

## Solution Options Considered

### Option 1: Shared Context Parameter

Add optional `sharedContext` parameter to `generateSchema()`.

**Pros:**

- Minimal API change
- Backward compatible

**Cons:**

- Leaky abstraction (context is implementation detail)
- Complex to use correctly
- Requires exposing context creation/management
- Context has many interdependent fields (cyclicTypes, anonymousNames, etc.)

### Option 2: Move Logic into SchemaGenerator ⭐ **RECOMMENDED**

Create a new method in SchemaGenerator specifically for synthetic TypeNodes.

**Pros:**

- Architecturally consistent with ObjectFormatter pattern
- Full access to formatChildType and context management
- Clean separation of concerns
- Solves the problem completely

**Cons:**

- Requires API change to createSchemaTransformerV2
- Slightly more complex initially

### Option 3: Return Definitions with Schema

Change return type to include definitions: `{ schema, definitions }`.

**Pros:**

- Explicit
- Caller controls merging

**Cons:**

- Breaking change
- Awkward API
- Doesn't handle nested contexts well

### Option 4: Force Inline (No $refs)

When `isRoot: false`, completely inline all schemas without $refs or
definitions.

**Pros:**

- Simple
- No context sharing needed

**Cons:**

- Duplicates type definitions
- Inconsistent with user's stated requirement
- Makes schemas unnecessarily verbose

## Recommended Solution

**Implement Option 2: Add `generateSchemaFromSyntheticTypeNode` method to
SchemaGenerator**

### Implementation Plan

#### 1. Add New Method to SchemaGenerator

```typescript
/**
 * Generate schema from a synthetic TypeNode that doesn't resolve to a proper Type.
 * Used by transformers that create synthetic type structures programmatically.
 *
 * @param typeNode - Synthetic TypeNode to analyze
 * @param checker - TypeScript type checker
 * @param typeRegistry - Optional map of TypeNode → Type for registered synthetic nodes
 */
public generateSchemaFromSyntheticTypeNode(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  typeRegistry?: Map<ts.TypeNode, ts.Type>,
): SchemaDefinition {
  // Create context (like generateSchema does)
  const cycles = this.getCycles(/* ... */);
  const context: GenerationContext = { /* ... */ };

  // Analyze TypeNode structure
  const schema = this.analyzeTypeNodeStructure(
    typeNode,
    checker,
    context,
    typeRegistry,
  );

  // Build final schema with $schema and $defs
  return this.buildFinalSchema(schema, /* ... */);
}

/**
 * Internal helper to analyze synthetic TypeNode structure.
 * Uses formatChildType for properties to share context properly.
 */
private analyzeTypeNodeStructure(
  typeNode: ts.TypeNode,
  checker: ts.TypeChecker,
  context: GenerationContext,
  typeRegistry?: Map<ts.TypeNode, ts.Type>,
): SchemaDefinition {
  if (ts.isTypeLiteralNode(typeNode)) {
    const properties: Record<string, SchemaDefinition> = {};
    const required: string[] = [];

    for (const member of typeNode.members) {
      // ... validate member ...

      let propType = typeRegistry?.get(member.type);
      if (!propType) {
        propType = checker.getTypeFromTypeNode(member.type);
      }

      let propSchema: SchemaDefinition;
      if (propType && !(propType.flags & ts.TypeFlags.Any)) {
        // Use formatChildType - shares context! 🎉
        propSchema = this.formatChildType(propType, context, member.type);
      } else {
        // Recurse on TypeNode structure
        propSchema = this.analyzeTypeNodeStructure(
          member.type,
          checker,
          context,
          typeRegistry,
        );
      }

      properties[propName] = propSchema;
      if (!member.questionToken) required.push(propName);
    }

    return { type: "object", properties, required };
  }

  // Handle keyword types, other TypeNode kinds...
}
```

#### 2. Update createSchemaTransformerV2

```typescript
export function createSchemaTransformerV2() {
  const generator = new SchemaGenerator();

  return {
    generateSchema(
      type: ts.Type,
      checker: ts.TypeChecker,
      typeNode?: ts.TypeNode,
      isRoot: boolean = true,
    ) {
      return generator.generateSchema(type, checker, typeNode, isRoot);
    },

    generateSchemaFromSyntheticTypeNode(
      typeNode: ts.TypeNode,
      checker: ts.TypeChecker,
      typeRegistry?: Map<ts.TypeNode, ts.Type>,
    ) {
      return generator.generateSchemaFromSyntheticTypeNode(
        typeNode,
        checker,
        typeRegistry,
      );
    },
  };
}
```

#### 3. Update Transformer

```typescript
const { generateSchema, generateSchemaFromSyntheticTypeNode } =
  createSchemaTransformerV2();

// In visitor:
if (
  (type.flags & ts.TypeFlags.Any) &&
  typeArg.pos === -1 && typeArg.end === -1
) {
  // Synthetic TypeNode path
  schema = generateSchemaFromSyntheticTypeNode(
    typeArg,
    checker,
    typeRegistry,
  );
} else {
  // Normal Type path
  schema = generateSchema(type, checker, typeArg);
}
```

### Why This Works

1. **Context sharing**: `formatChildType` is called for properties, sharing the
   same context across all property generations
2. **Proper
   $refs**: Named types like `Item` are stored in `context.definitions` and referenced via `$ref`
3. **Single $defs**: All definitions accumulate in one place
4. **Root-level $schema**: Only added by `buildFinalSchema` at the outermost
   level
5. **Recursive structure**: Handles nested TypeLiterals correctly by recursing
   with same context

### Expected Output

For a callback param type like:

```typescript
{
  element: Item;
  params: {
    prefix: string;
  }
}
```

Generated schema:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "element": {
      "$ref": "#/$defs/Item"
    },
    "params": {
      "type": "object",
      "properties": {
        "prefix": { "type": "string", "asOpaque": true }
      }
    }
  },
  "$defs": {
    "Item": {
      "type": "object",
      "properties": {/* ... */}
    }
  }
}
```

## Migration Path

1. Implement new method in SchemaGenerator
2. Update createSchemaTransformerV2 to return object with both methods
3. Update transformer to use new method for synthetic TypeNodes
4. Remove `isRoot` parameter (no longer needed with proper context sharing)
5. Update tests to expect correct schema structure

## Related Files

- `packages/schema-generator/src/schema-generator.ts` - Add new method
- `packages/schema-generator/src/plugin.ts` - Update return type
- `packages/ts-transformers/src/transformers/schema-generator.ts` - Use new
  method
- `packages/ts-transformers/src/closures/transformer.ts` - TypeRegistry usage
