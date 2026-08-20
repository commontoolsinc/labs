# Cross-Space Handler State Must Be a Cell Link

**Error:** `action argument is undefined (potential schema mismatch) -- not
running` in the runner log — and nothing else. The handler silently does not
run: no throw, no UI error.

**Cause:** The handler's state includes a value that lives in another space —
typically a profile or other owner-protected record — typed as the plain value
(for example `profile: ProfileHomeOutput`). To build the action argument, the
runner resolves the state to values. A cross-space value may not be loaded at
the moment the event fires (the first read kicks off an async load; the value
lands later), so required fields resolve to `undefined`, the argument fails its
schema, and the runner skips the action.

**Fix:** Type the state field as `Cell<T>` so the runner passes the link
without resolving it at event time. Read through the cell inside the handler
body, where the load can complete.

```typescript
// Shown at module scope.
interface Profile {
  name: string;
}

// ❌ Plain value type — argument validation resolves the cross-space value
const usePlain = handler<unknown, { profile: Profile }>(
  (_, { profile }) => {
    console.log(profile.name);
  },
);

// ✅ Cell<> type — the link passes through; read inside the handler
const useLink = handler<unknown, { profile: Cell<Profile> }>(
  (_, { profile }) => {
    console.log(profile.get()?.name);
  },
);
```

Storing the link also round-trips: `cell.set(otherCell)` persists a link, and
`equals()` follows links, so identity checks against list entries still work.

The same rule holds even though cross-space reads materialize their targets:
event-time argument validation is synchronous, so it must not depend on a value
that may not have loaded yet. A link never has that dependency.

## See Also

- [@handler](../../../common/concepts/handler.md) — handler state binding
- [A Field Typed `unknown` Reads Back as a Reference](unknown-typed-field-reads-a-reference.md)
  — the reading operand's schema decides what materializes
