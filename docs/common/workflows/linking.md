Separate patterns may share data through explicit linking:

```bash
# Deploy both charms
deno task ct charm new ... editor.tsx   # Returns: editor-id
deno task ct charm new ... viewer.tsx   # Returns: viewer-id

# Link their data
deno task ct charm link ... editor-id/items viewer-id/items
```

Or by being constructed from other patterns in the first place.
