### Direct Property Access on Computed Objects

You can access properties directly on computed objects:

```tsx
import { computed, UI, pattern } from 'commontools';

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
import { UI, pattern } from 'commontools';

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
