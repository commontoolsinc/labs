# SELF Symbol

`SELF` provides a typed reference to the pattern's own output, enabling self-referential data structures.

## Use Cases

- **Recursive structures**: Children that reference their parent (trees, graphs)
- **Self-registration**: Adding the current charm to a collection or registry

## Basic Usage

```typescript
import { pattern, SELF, UI, Writable } from "commontools";

interface Input {
  label: string;
  parent: Output | null;
  registry: Writable<Output[]>;
}

interface Output {
  label: string;
  parent: Output | null;
  children: Output[];
}

const Node = pattern<Input, Output>(({ label, parent, registry, [SELF]: self }) => {
  const children = Writable.of<Output[]>([]);

  return {
    label,
    parent,
    children,
    [UI]: (
      <div>
        <button onClick={() => children.push(Node({ label: "Child", parent: self, registry }))}>
          Add Child
        </button>
        <button onClick={() => registry.push(self)}>
          Add to Registry
        </button>
      </div>
    ),
  };
});
```

## Key Rules

1. **Both type parameters required**: Use `pattern<Input, Output>()` when accessing SELF. Using single-param `pattern<Input>()` will produce a type error.

2. **`self` is typed as the output**: The destructured `self` variable is typed as `OpaqueRef<Output>`, representing the instantiated charm itself.

## Reference

See `packages/patterns/self-reference-test.tsx` for a complete working example.
