### Direct Property Access on Computed Objects

You can access properties directly on computed objects:

```tsx
import { computed, UI, pattern } from 'commonfabric';

interface User { name: string; }
interface Post { title: string; }
interface Config { theme: string; }
interface Input {
  users: User[];
  posts: Post[];
  config: Config;
}

export default pattern<Input>(({ users, posts, config }) => {
  const data = computed(() => ({
    users,
    posts,
    config
  }));

  return {
    [UI]: (
      <>
        {/* ✅ Direct property access works */}
        <div>{data.users.length} users</div>
        <div>Theme: {data.config.theme}</div>

        {/* ✅ Can nest property access */}
        {data.users.map(user => (
          <div>{user.name}</div>
        ))}
      </>
    ),
  };
});
```

### Reactivity

Reactivity is completely automatic in JSX:

```tsx
import { UI, pattern } from 'commonfabric';

interface Item { title: string; }
interface Input {
  count: number;
  items: Item[];
  user: { name: string; };
}

export default pattern<Input>(({ count, items, user }) => ({
  // ✅ All of these are reactive
  [UI]: (
    <div>
      {count}
      {count > 10 ? "High" : "Low"}
      {items.length}
      {user.name}
      {items.map(item => <div>{item.title}</div>)}
    </div>
  ),
}));
```

### Conditional Expressions And Other Lowered Value Sites

Plain ternaries work in more than just JSX children. In current main, they
also work across most ordinary value-expression positions in normal pattern
code.

```tsx
export default pattern<Input>(({ count, items, user }) => {
  const badgeText = count > 10 ? "High" : "Low";

  return {
    [UI]: (
      <div
        style={{ opacity: count > 0 ? 1 : 0.5 }}
        data-state={user.name ? "ready" : "empty"}
      >
        <button disabled={items.length === 0}>
          {items.length === 0 ? "No items" : "Open list"}
        </button>
        <span>{badgeText}</span>
      </div>
    ),
  };
});
```

If you're debugging a less common site, inspect the emitted source with
`deno task cf check <pattern>.tsx --show-transformed`.
