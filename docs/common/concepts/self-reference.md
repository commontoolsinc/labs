# Self-Referential Types with SELF

Use `SELF` to get a reference to the pattern's own output, useful for:
- Creating children with a parent reference back to self
- Adding self to a collection (e.g., registering in a list)

## Example

```typescript
import { Default, pattern, SELF, UI, Writable } from "commontools";

interface Input {
  label: Default<string, "Untitled">;
  parent: Default<Output | null, null>;
  registry: Writable<Default<Output[], []>>;
}
interface Output {
  label: string;
  parent: Output | null;
  children: Output[];
}

const Node = pattern<Input, Output>(
  ({ label, parent, registry, [SELF]: self }) => {
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
  },
);

export default Node;
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

- `packages/patterns/self-reference-test.tsx` - Working example
