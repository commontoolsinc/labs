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
without resolving it, and have the handler **operate on the link** — compare
it, store it, remove it — rather than read through it.

```typescript
// Shown at module scope.
interface Profile {
  name: string;
}

// ❌ Plain value type — argument validation resolves the cross-space value
const selectPlain = handler<unknown, {
  profile: Profile;
  selected: Writable<Profile | undefined>;
}>((_, { profile, selected }) => {
  selected.set(profile);
});

// ✅ Cell<> type — the link passes through, and the handler moves the link
const selectLink = handler<unknown, {
  profile: Cell<Profile>;
  selected: Writable<Cell<Profile> | undefined>;
}>((_, { profile, selected }) => {
  selected.set(profile);
});
```

Storing the link round-trips: `cell.set(otherCell)` persists a link, and
`equals()` follows links, so identity checks against list entries still work.

**Do not treat `Cell<T>` as a way to read the value later in the same
handler.** Handlers are synchronous, and `get()` on an unsynced cell starts a
sync without awaiting it, so a first, cold invocation can still see the
target's fields absent. If the handler genuinely needs the target's contents,
arrange for them to be materialized reactively before the event — for example
by rendering or deriving from the value in the pattern body — and keep the
handler itself operating on the link.

The rule holds even though cross-space reads materialize their targets:
event-time argument validation is synchronous, so it must not depend on a
value that may not have loaded yet. A link never has that dependency.

## See Also

- [@handler](../../../common/concepts/handler.md) — handler state binding
- [A Field Typed `unknown` Reads Back as a Reference](unknown-typed-field-reads-a-reference.md)
  — the reading operand's schema decides what materializes
