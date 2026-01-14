Export a `mentionable` property to make child charms appear in `[[` autocomplete:

```tsx
export default pattern<Input, Output>(({ ... }) => {
  const childCharm = ChildPattern({ ... });

  return {
    [NAME]: "Parent",
    [UI]: <div>...</div>,
    mentionable: [childCharm],  // Makes childCharm discoverable via [[
  };
});
```

For dynamic collections, use a Cell:

```tsx
const createdCharms = Cell.of<any[]>([]);

const create = handler((_, { createdCharms }) => {
  createdCharms.push(ChildPattern({ name: "New" }));
});

return {
  [UI]: <ct-button onClick={create({ createdCharms })}>Create</ct-button>,
  mentionable: createdCharms,  // Cell is automatically unwrapped
};
```

**Notes:**
- Exported mentionables appear in `[[` autocomplete
- They do NOT appear in the sidebar charm list
- Use this instead of writing to `allCharms` directly
