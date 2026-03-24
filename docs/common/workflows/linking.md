Separate patterns may share data through explicit linking:

```bash
# Deploy both pieces
deno task cf piece new ... editor.tsx   # Returns: editor-id
deno task cf piece new ... viewer.tsx   # Returns: viewer-id

# Link their data
deno task cf piece link ... editor-id/items viewer-id/items
```

Or by being constructed from other patterns in the first place.
