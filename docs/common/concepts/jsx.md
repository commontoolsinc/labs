
### Direct Property Access on Computed Objects

You can access properties directly on computed objects:

```typescript
const data = computed(() => ({
  users: [...],
  posts: [...],
  config: {...}
}));

// ✅ Direct property access works
<div>{data.users.length} users</div>
<div>Theme: {data.config.theme}</div>

// ✅ Can nest property access
{data.users.map(user => (
  <div>{user.name}</div>
))}
```

### Reactivity

Reactivity is completely automatic in JSX:

```typescript
// ✅ All of these are reactive
<div>
  {count}
  {count > 10 ? "High" : "Low"}
  {items.length}
  {user.name}
  {items.map(item => <div>{item.title}</div>)}
</div>
```
