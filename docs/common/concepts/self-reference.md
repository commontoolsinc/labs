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

## SELF in Actions

`self` works inside `action()` closures, not just inline arrows:

```typescript
const createChild = action(() => {
  children.push(Node({ label: "Child", parent: self, registry }));
});
```

**Gotcha:** At runtime, `self` binds against the output schema. If any required output property is missing from the piece data, the binding resolves to `undefined`. This happens when input properties lack defaults:

```typescript
// BAD: title might be missing from piece data → self binding fails
interface Input { title?: string; }

// GOOD: Default<> ensures a value always exists
interface Input { title: Default<string, "Untitled">; }
```

## Key Rules

- **Both type params required:** Use `pattern<Input, Output>()` - single param `pattern<Input>()` will error if you access SELF
- **`self` is typed as the output** - the instantiated piece itself, enabling recursive structures
- **Inputs need defaults:** If an input feeds into the output, use `Default<T, V>` so `self` can bind

## See Also

- `packages/patterns/self-reference-test.tsx` - Canonical example
- `packages/patterns/notes/notebook.tsx` - Real-world parent-child usage
- `packages/patterns/notes/note.tsx` - Reading parent from self
