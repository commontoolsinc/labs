# Testing Patterns

## Local Testing

```bash
# Check syntax only (fast)
deno task ct check pattern.tsx --no-run

# Run locally
deno task ct check pattern.tsx

# View transformer output (debug compile issues)
deno task ct check pattern.tsx --show-transformed
```

## Deployed Testing

```bash
# Deploy
deno task ct charm new --identity key.json --api-url URL --space SPACE pattern.tsx
# Returns: charm-id

# Set test data
echo '{"title": "Test", "done": false}' | \
  deno task ct charm set --identity key.json --api-url URL --space SPACE --charm ID testItem

# Inspect full state
deno task ct charm inspect --identity key.json --api-url URL --space SPACE --charm ID

# Get specific field
deno task ct charm get --identity key.json --api-url URL --space SPACE --charm ID items/0/title
```

## Iterate Quickly with setsrc

Use `setsrc` to update existing charm without creating new one:

```bash
deno task ct charm setsrc --identity key.json --api-url URL --space SPACE --charm ID pattern.tsx
```

This keeps you working with the same charm instance, preserving any test data you've set up.

## See Also

- ./cli-debugging.md - CLI debugging commands and workflows
- ./workflow.md - General debugging workflow
