# Self-Referential Types with SELF

Use `SELF` to get a reference to the pattern's own output. This enables recursive structures like trees, parent-child relationships, and self-registration.

## Quick Start

```typescript
import { pattern, SELF, Writable, UI } from "commontools";

interface TreeNodeInput {
  name: string;
  parent: TreeNodeOutput | null;
}

interface TreeNodeOutput {
  name: string;
  parent: TreeNodeOutput | null;
  children: TreeNodeOutput[];
}

const TreeNode = pattern<TreeNodeInput, TreeNodeOutput>(
  ({ name, parent, [SELF]: self }) => {
    const children = Writable.of<TreeNodeOutput[]>([]);

    return {
      name,
      parent,
      children,
      [UI]: (
        <button onClick={() => children.push(TreeNode({ name: "Child", parent: self }))}>
          Add Child
        </button>
      ),
    };
  }
);
```

## How SELF Works

When your pattern runs:

1. The runtime creates a reference (`self`) that will point to your pattern's output
2. You can pass `self` to child patterns before your pattern finishes executing
3. Once your pattern returns, `self` resolves to the actual output cell
4. Children that received `self` now have a valid reference to their parent

This is why `SELF` works—it's a forward reference that gets bound after your pattern body executes.

## Type Signature

To use SELF, specify both your input and output types:

```typescript
interface MyInput { ... }
interface MyOutput { ... }

const MyPattern = pattern<MyInput, MyOutput>(({ [SELF]: self }) => {
  // self is typed as OpaqueRef<MyOutput>
  return { ... };
});
```

The full type signature:

```typescript
export interface PatternFunction {
  <T, R>(
    fn: (input: OpaqueRef<Required<T>> & { [SELF]: OpaqueRef<R> }) => Opaque<R>,
  ): RecipeFactory<StripCell<T>, StripCell<R>>;
}
```

With both type parameters, `self` is typed as `OpaqueRef<R>` (your output type).

## Common Patterns

### Parent-Child References

The most common use of SELF: children that can navigate back to their parent.

```typescript
interface NoteInput {
  title: string;
  notebook: NotebookOutput | null;
}

interface NotebookOutput {
  title: string;
  notes: NoteOutput[];
}

const Notebook = pattern<NotebookInput, NotebookOutput>(
  ({ title, [SELF]: self }) => {
    const notes = Writable.of<NoteOutput[]>([]);

    return {
      title,
      notes,
      [UI]: (
        <button onClick={() => {
          notes.push(Note({
            title: "New Note",
            notebook: self  // Pass self as parent reference
          }));
        }}>
          Add Note
        </button>
      ),
    };
  }
);
```

### Self-Registration

Add yourself to a collection:

```typescript
const Node = pattern<NodeInput, NodeOutput>(
  ({ registry, [SELF]: self }) => {
    return {
      [UI]: (
        <button onClick={() => registry.push(self)}>
          Add to Registry
        </button>
      ),
    };
  }
);
```

### Reading Self's Properties

Since `self` is typed as `OpaqueRef<Output>`, you can access any property defined in your Output type directly:

```typescript
import { action, computed, NAME, navigateTo, pattern, SELF } from "commontools";

interface NotebookOutput {
  title: string;
  parentNotebook: NotebookOutput | null;
  // ...
}

const Notebook = pattern<NotebookInput, NotebookOutput>(
  ({ [SELF]: self }) => {
    // Direct property access works - no casting needed
    const hasParent = computed(() => !!self.parentNotebook);
    const parentLabel = computed(() => {
      const p = self.parentNotebook;
      return p?.[NAME] ?? p?.title ?? "Parent";
    });

    // Use in actions too
    const goToParent = action(() => {
      const p = self.parentNotebook;
      if (p) navigateTo(p);
    });

    return { ... };
  }
);
```

The key insight: if a property is in your Output type, you can read it from `self` without type assertions.

## Gotchas

### Reading SELF in Reactive Contexts

Usually you'll want to access properties on SELF inside reactive contexts like `computed` or `action`:

```typescript
const hasParent = computed(() => !!self.parentNotebook);
const goToParent = action(() => navigateTo(self.parentNotebook));
```

### Circular References Are Intentional

When you pass `self` to a child, you're creating a circular reference graph. This is fine—the reactive system handles it. But be mindful when serializing or debugging.

## Internal Details

How SELF works under the hood:

### 1. Symbol Definition

`SELF` is a `unique symbol` exported from `packages/api/index.ts:19-21`:

```typescript
export declare const SELF: unique symbol;
export type SELF = typeof SELF;
```

### 2. Pattern Creation (`packages/runner/src/builder/recipe.ts:46-78`)

When `pattern()` is called:

```typescript
export const pattern: PatternFunction = (fn, argumentSchema?, resultSchema?) => {
  const frame = pushFrame();

  // Create OpaqueRef for the arguments
  const inputs = opaqueRef(undefined, argumentSchema);

  // Create a separate OpaqueRef for the result (this becomes self)
  const selfRef = opaqueRef(undefined, resultSchema);

  // Attach selfRef to the inputs cell so the proxy can return it
  getCellOrThrow(inputs).setSelfRef(selfRef);

  // ... run the pattern function with inputs ...
};
```

### 3. Proxy Access (`packages/runner/src/cell.ts:1378-1380`)

When you access `inputs[SELF]`, the cell proxy intercepts this:

```typescript
} else if (prop === SELF) {
  return (self as unknown as CellImpl<T>)._selfRef;
}
```

It returns the stored `_selfRef` which points to the result cell.

### 4. Serialization (`packages/runner/src/builder/recipe.ts:331-334`)

During serialization, `selfRef` is mapped to the path `["resultRef"]`:

```typescript
paths.set(selfRefCell, ["resultRef"]);
```

At runtime, `resultRef` points to the actual output cell when the pattern is instantiated.

## See Also

- `packages/patterns/self-reference-test.tsx` - Canonical example
- `packages/patterns/notes/notebook.tsx` - Real-world parent-child usage
- `packages/patterns/notes/note.tsx` - Reading parent from self
