### Direct Data Access

```tsx
// ❌ Error: reactive reference outside reactive context
for (const entry of entries) { ... }

// ✅ Wrap in computed()
const result = computed(() => {
  for (const entry of entries) { ... }
});
```

### Template String Access

```typescript
// ❌ Error: reactive reference from outer scope
const prompt = `Seed: ${seed}`;

// ✅ Wrap in computed()
const prompt = computed(() => `Seed: ${seed}`);
```
