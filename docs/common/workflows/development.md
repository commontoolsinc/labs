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
  fields must be optional or have defaults. Input `anyOf` and type-array unions
  may be widened and result `anyOf` and type-array unions may be narrowed,
  including Common Fabric schema types such as `undefined`. For open argument
  objects, the piece's durable arguments are
  also validated against newly named fields before the update commits.
  Defaults introduced by an accepted update are migrated recursively through
  present objects, array items, and typed dynamic fields. Durable input links
  are preserved only when the producer-owned Piece result contract fits the
  destination contract; carried/narrowed view schemas and one currently
  materialized value are not sufficient. Existing links are rechecked inside
  the update transaction, and Piece result writes preserve those contracts.
  Cell capabilities are part of the proof: restricted handles cannot be
  amplified or stripped into ordinary read/write aliases, and redirected
  writes use the producer-owned capability and payload schema. Redirected
  descendant writes are staged against the complete producer argument or
  internal schema and every public result projection, so container and parent
  constraints remain valid as well as the written leaf.
  A destination default can satisfy a link only beneath ancestors that remain
  valid after default insertion; path links through correlated schemas (for
  example, a discriminated union) are rejected when no durable proof is
  possible. Because an absent Fabric path reads as `undefined`, a linked source
  object field must be unconditionally object-shaped and required unless the
  destination accepts `undefined`. Array indices can always be sparse, even
  when covered by `minItems`, so their destinations must accept `undefined`; a
  source-side default alone does not prove raw path presence.
  This migrates the piece's current state; clients holding an older argument
  link must refresh it before writing again so they use the updated schema.
  Concurrent updates are applied atomically; a stale update fails instead of
  overwriting a newer source.
- Test one feature at a time
