Export a `mentionable` property to make child pieces appear in `[[` autocomplete:

```tsx
export default pattern<Input, Output>(({ ... }) => {
  const childPiece = ChildPattern({ ... });

  return {
    [NAME]: "Parent",
    [UI]: <div>...</div>,
    mentionable: [childPiece],  // Makes childPiece discoverable via [[
  };
});
```

For dynamic collections, use a Writable:

```tsx
const createdPieces = Writable.of<any[]>([]);

const create = handler((_, { createdPieces }) => {
  createdPieces.push(ChildPattern({ name: "New" }));
});

return {
  [UI]: <ct-button onClick={create({ createdPieces })}>Create</ct-button>,
  mentionable: createdPieces,
};
```

**Notes:**
- Exported mentionables appear in `[[` autocomplete
- They do NOT appear in the sidebar piece list
- Use this instead of writing to `allPieces` directly

# Wishing for Mentionables

Patterns can discover mentionables in the current space using the `scope` parameter:

```tsx
// Search mentionables in current space
const result = wish<{ content: string }>({ query: "#note", scope: ["."] });

// Search both favorites and mentionables
const result = wish<{ content: string }>({ query: "#note", scope: ["~", "."] });
```

See [[FAVORITES]] for full documentation of the `wish` scope parameter.
