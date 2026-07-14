## Development Workflow

```bash
# Check syntax (fast)
deno task cf check pattern.tsx --no-run

# Test locally
deno task cf check pattern.tsx

# Deploy
deno task cf piece new ... pattern.tsx

# Update existing (faster iteration)
deno task cf piece setsrc ... --piece PIECE_ID pattern.tsx

# Inspect data
deno task cf piece inspect ... --piece PIECE_ID

# Link data between deployed pieces (shares cells across patterns)
deno task cf piece link ... editor-id/items viewer-id/items
```

**Tips:**
- Use `check` first to catch TypeScript errors
- Deploy once, then use `setsrc` for updates
- `setsrc` rejects backward-incompatible argument or result schema changes
  before updating the piece. Existing fields must keep compatible types; new
  fields must be optional or have defaults. Input unions may be widened and
  result unions may be narrowed, including Common Fabric schema types such as
  `undefined`. For open argument objects, the piece's durable arguments are
  also validated against newly named fields before the update commits.
  This migrates the piece's current state; clients holding an older argument
  link must refresh it before writing again so they use the updated schema.
  Concurrent updates are applied atomically; a stale update fails instead of
  overwriting a newer source.
- Test one feature at a time
