### No Async/Await

All async results are reactive nodes, not promises:

```typescript
// ❌ Don't await
const result = await generateText({ prompt });

// ✅ Check pending/error/result
const result = generateText({ prompt });
if (!result.pending && !result.error) {
  // use result.result
}
```
