
### When NOT to Use computed()

**Within JSX, reactivity is automatic—you don't need `computed()`:**

```typescript
// ❌ Don't use computed() in JSX
<div>
  {computed(() => `Hello, ${userName}`)}  // Unnecessary!
</div>

// ✅ Just reference directly
<div>
  Hello, {userName}
</div>

// ❌ Don't use computed() for simple property access
<div>
  {computed(() => user.name)}  // Unnecessary!
</div>

// ✅ Direct access works fine
<div>
  {user.name}
</div>
```
