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
```

**Tips:**
- Use `check` first to catch TypeScript errors
- Deploy once, then use `setsrc` for updates
- Test one feature at a time
