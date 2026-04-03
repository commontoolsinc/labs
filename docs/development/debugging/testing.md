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
deno task ct piece new --identity key.json --api-url URL --space SPACE pattern.tsx
# Returns: piece-id

# Set test data
echo '{"title": "Test", "done": false}' | \
  deno task ct piece set --identity key.json --api-url URL --space SPACE --piece ID testItem

# Inspect full state
deno task ct piece inspect --identity key.json --api-url URL --space SPACE --piece ID

# Get specific field
deno task ct piece get --identity key.json --api-url URL --space SPACE --piece ID items/0/title
```

## Iterate Quickly with setsrc

Use `setsrc` to update existing piece without creating new one:

```bash
deno task ct piece setsrc --identity key.json --api-url URL --space SPACE --piece ID pattern.tsx
```

This keeps you working with the same piece instance, preserving any test data you've set up.

## See Also

- ./cli-debugging.md - CLI debugging commands and workflows
- ./workflow.md - General debugging workflow
