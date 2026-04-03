## Development Workflow

```bash
# Check syntax (fast)
deno task ct check pattern.tsx --no-run

# Test locally
deno task ct check pattern.tsx

# Deploy
deno task ct piece new ... pattern.tsx

# Update existing (faster iteration)
deno task ct piece setsrc ... --piece PIECE_ID pattern.tsx

# Inspect data
deno task ct piece inspect ... --piece PIECE_ID
```

**Tips:**
- Use `check` first to catch TypeScript errors
- Deploy once, then use `setsrc` for updates
- Test one feature at a time
