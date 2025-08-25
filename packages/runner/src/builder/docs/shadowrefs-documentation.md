# Opaque Values, Closures, and ShadowRefs Documentation

## Overview

This document explains how opaque values, closures, and shadowrefs work in the
CommonTools builder system, with a focus on what should be seen in a shadowref.

## Opaque Values and OpaqueRef

### What are Opaque Values?

Opaque values are wrapped values that represent future cells in the recipe
system. They are created using the `opaqueRef()` function and serve as proxies
for values that will eventually be materialized.

### OpaqueRef Implementation

From `packages/runner/src/builder/opaque-ref.ts`:

```typescript
export function opaqueRef<T>(
  value?: Opaque<T> | T,
  schema?: JSONSchema,
): OpaqueRef<T>;
```

Key features:

- **Proxy-based**: Uses JavaScript Proxy to intercept property access
- **Nested access**: Supports deep property access (e.g., `ref.a.b.c`)
- **Methods**: Provides `.set()`, `.get()`, `.setDefault()`, `.setName()`,
  `.setSchema()`
- **Frame tracking**: Each OpaqueRef is associated with a recipe frame
- **Connection tracking**: Tracks which nodes use this ref

### Internal Structure

An OpaqueRef maintains:

```typescript
const store = {
  value, // The actual value
  defaultValue: undefined, // Default value if not set
  nodes: new Set<NodeRef>(), // Connected nodes
  frame: getTopFrame()!, // Recipe frame context
  name: undefined, // Optional name
  schema: schema, // JSON schema
};
```

## Closures in Recipes

### Recipe Closures

Closures occur when recipes capture variables from their surrounding scope. This
is particularly important for:

- Map operations that use external factors
- Lifted functions that reference outer variables
- Computed values that depend on parent recipe context

Example from tests:

```typescript
const doubleArray = recipe<{ values: number[]; factor: number }>(
  "Double numbers",
  ({ values, factor }) => {
    const doubled = values.map((x) => double({ x, factor }));
    return { doubled };
  },
);
```

### Unsafe Closures

The system tracks "unsafe closures" - recipes that reference values from parent
frames:

- Marked with `unsafe_originalRecipe` symbol
- Require special materialization handling
- Must track parent recipe relationships

## ShadowRefs

### What is a ShadowRef?

A ShadowRef is a reference to an OpaqueRef from a different (parent) frame. It
acts as a cross-frame pointer to maintain referential integrity across recipe
boundaries.

### ShadowRef Structure

From `packages/runner/src/builder/types.ts`:

```typescript
export type ShadowRef = {
  shadowOf: OpaqueRef<any> | ShadowRef;
};
```

### When are ShadowRefs Created?

ShadowRefs are created when:

1. An OpaqueRef from a parent frame is referenced in a child frame
2. During recipe factory creation when collecting cells and nodes
3. When connecting nodes across frame boundaries

From `packages/runner/src/builder/node-utils.ts`:

```typescript
if (value.export().frame !== node.frame) return createShadowRef(value);
```

### What Should Be Seen in a ShadowRef?

A ShadowRef should contain:

1. **shadowOf property**: Reference to the original OpaqueRef (or another
   ShadowRef)
   - Points to the actual value holder
   - Maintains the chain back to the original ref

2. **Cross-frame reference**: Indicates that the referenced value exists in a
   different recipe frame
   - Prevents direct cross-frame mutations
   - Ensures proper value propagation

3. **Serialization format**: When serialized to JSON:

   ```typescript
   {
     $alias: {
       cell: shadowRef,  // The shadow reference itself
       path: [...],      // Path to the value
       schema: {...},    // Optional schema information
       rootSchema: {...} // Optional root schema
     }
   }
   ```

### When are ShadowRefs Dereferenced?

ShadowRefs are dereferenced in several key scenarios:

#### 1. During Recipe Factory Creation

From `packages/runner/src/builder/recipe.ts`:

```typescript
if (isShadowRef(value)) {
  shadows.add(value);
  if (
    isOpaqueRef(value.shadowOf) &&
    value.shadowOf.export().frame === getTopFrame()
  ) {
    cells.add(value.shadowOf); // Dereference to add the actual cell
  }
}
```

**Purpose**: When collecting cells and nodes for a recipe, shadowrefs are
dereferenced to:

- Add the actual OpaqueRef to the cells collection if it belongs to the current
  frame
- Ensure proper graph traversal and dependency tracking
- Maintain the connection between shadowrefs and their target cells

#### 2. During JSON Serialization

From `packages/runner/src/builder/json-utils.ts`:

```typescript
if (isShadowRef(alias.cell)) {
  const cell = alias.cell.shadowOf; // Dereference to get the actual cell
  if (cell.export().frame !== getTopFrame()) {
    // Frame validation logic...
  }
  if (!paths.has(cell)) throw new Error(`Cell not found in paths`);
  return {
    $alias: {
      path: [...paths.get(cell)!, ...alias.path] as (string | number)[],
    },
  } satisfies LegacyAlias;
}
```

**Purpose**: During serialization, shadowrefs are dereferenced to:

- Access the actual OpaqueRef for path resolution
- Validate frame relationships
- Create proper alias structures with resolved paths
- Ensure the serialized form correctly represents the cross-frame reference

#### 3. During Node Connection

From `packages/runner/src/builder/node-utils.ts`:

```typescript
if (isOpaqueRef(value)) {
  // Return shadow ref if this is a parent opaque ref. Note: No need to
  // connect to the cell. The connection is there to traverse the graph to
  // find all other nodes, but this points to the parent graph instead.
  if (value.export().frame !== node.frame) return createShadowRef(value);
  value.connect(node);
}
```

### ShadowRef Resolution During Recipe Instantiation

When a recipe is instantiated and executed, shadowrefs are resolved through the
`unsafe_materialize` mechanism. This happens when OpaqueRefs (including those
referenced by shadowrefs) are accessed during recipe execution.

#### The Resolution Process

From `packages/runner/src/builder/opaque-ref.ts`:

```typescript
function unsafe_materialize(
  binding: { recipe: Recipe; path: PropertyKey[] } | undefined,
  path: PropertyKey[],
) {
  if (!binding) throw new Error("Can't read value during recipe creation.");

  // Find first frame with unsafe binding
  let frame = getTopFrame();
  let unsafe_binding: UnsafeBinding | undefined;
  while (frame && !unsafe_binding) {
    unsafe_binding = frame.unsafe_binding;
    frame = frame.parent;
  }

  // Walk up the chain until we find the original recipe
  while (unsafe_binding && unsafe_binding.parent?.recipe === binding.recipe) {
    unsafe_binding = unsafe_binding.parent;
  }

  if (!unsafe_binding) throw new Error("Can't find recipe in parent frames.");

  return unsafe_binding.materialize([...binding.path, ...path]);
}
```

#### How ShadowRef Resolution Works

The resolution process follows this flow:

1. **OpaqueRef Access**: When an OpaqueRef is accessed (via `.get()`, property
   access, or `Symbol.toPrimitive`), it calls `unsafe_materialize`

2. **Frame Traversal**: `unsafe_materialize` walks up the frame stack to find
   the first frame with an `unsafe_binding`

3. **Recipe Chain Resolution**: It then walks up the chain of
   `unsafe_binding.parent` references until it finds the original recipe that
   contains the shadowref

4. **Materialization**: Finally, it calls
   `unsafe_binding.materialize([...binding.path, ...path])` which resolves the
   actual value

#### Where UnsafeBinding is Set Up

The `unsafe_binding` is created during recipe execution in
`packages/runner/src/runner.ts`:

```typescript
const frame = pushFrameFromCause(
  { inputs, outputs, fn: fn.toString() },
  {
    recipe,
    materialize: (path: readonly PropertyKey[]) =>
      processCell.getAsQueryResult(path, tx),
    space: processCell.space,
    tx,
  } satisfies UnsafeBinding,
);
```

#### ShadowRef to Real Value Conversion

During this process:

- **ShadowRefs** → **OpaqueRefs** → **Real Values**
- When a shadowref is accessed, `unsafe_materialize` follows the `shadowOf`
  chain
- The `materialize` function uses `processCell.getAsQueryResult(path, tx)` to
  get the actual value
- This resolves cross-frame references by accessing the actual cell data in the
  correct execution context

#### When Resolution Occurs

Shadowref resolution happens automatically when:

1. **Property Access**: Accessing properties on OpaqueRefs that reference
   shadowrefs
2. **Value Retrieval**: Calling `.get()` on OpaqueRefs
3. **Primitive Conversion**: When OpaqueRefs are converted to primitives (via
   `Symbol.toPrimitive`)
4. **Recipe Execution**: During the execution of recipes that contain shadowrefs

This resolution is essential for:

- **Value Access**: Converting cross-frame references into accessible values
- **Reactivity**: Ensuring that changes to shadowrefs propagate correctly
- **Execution Context**: Binding shadowrefs to the correct execution frame
- **Data Flow**: Maintaining proper data flow across recipe boundaries

### ShadowRef Usage in JSON Serialization

From `packages/runner/src/builder/json-utils.ts`:

- ShadowRefs are handled specially during serialization
- They maintain the reference structure when converting to JSON
- The system tracks paths to resolve shadow references correctly

### Key Properties of ShadowRefs

1. **Immutability**: ShadowRefs are read-only references
2. **Frame safety**: Prevent direct cross-frame mutations
3. **Path preservation**: Maintain the path to the original value
4. **Type checking**: `isShadowRef()` function for runtime type checking

## Nested Recipes and ShadowRef Resolution

### The Issue with Nested Recipes

When a recipe contains another recipe (nested recipes), a subtle issue can arise
during JSON serialization:

1. **Build Time**: `toJSONWithLegacyAliases` processes the outer recipe and
   converts shadowrefs to proper aliases
2. **The Problem**: Nested recipes retain their original `toJSON()` method,
   which has a closure referencing the un-transformed recipe containing
   shadowrefs
3. **Runtime**: When the nested recipe's `toJSON()` is called, it returns the
   original structure with shadowrefs, which the runtime cannot handle

### Example

```typescript
const innerRecipe = recipe<{ x: number }>("Inner", ({ x }) => {
  // This recipe might capture variables from parent scope
  return { squared: x * x };
});

const outerRecipe = recipe<{ value: number }>("Outer", ({ value }) => {
  // When serialized, innerRecipe keeps its original toJSON method
  const nested = innerRecipe({ x: value });
  return { nested };
});
```

### The Solution

In `toJSONWithLegacyAliases`, nested recipes must be handled specially:

```typescript
if (isRecipe(value) && typeof value.toJSON === "function") {
  // Call toJSON() to get the properly serialized version
  value = value.toJSON();
}
// Then continue processing the serialized result
```

This ensures that:

- Shadowrefs are resolved during the build phase
- Nested recipes don't keep their original `toJSON` method
- The runtime never encounters shadowrefs

### Key Insight

**ShadowRefs should never reach the runtime**. They are build-time constructs
that must be resolved during recipe serialization. The runtime only understands:

- Numbers (for nested recipe references)
- Entity IDs (in the format `{ "/": "..." }`)
- Resolved cell references

If shadowrefs appear at runtime, it indicates a serialization bug where the
build-time resolution process was incomplete.

## Summary

- **OpaqueRef**: Proxy-based future value holders within a recipe frame
- **Closures**: Captured variables requiring special handling for cross-recipe
  references
- **ShadowRef**: Cross-frame references that maintain referential integrity

ShadowRefs should be seen as lightweight pointers that:

- Reference values from parent frames
- Prevent direct cross-frame mutations
- Preserve the connection to the original OpaqueRef
- Enable proper serialization and deserialization of cross-frame references
- Must be fully resolved before reaching runtime execution
