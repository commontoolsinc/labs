
## Writable<T[]> vs Writable<Array<Writable<T>>>

**Use `Writable<T[]>` by default:**

```typescript
import { handler, Writable } from 'commontools';

interface Item {
  title: string;
  done: boolean;
}

const addItem = handler<unknown, { items: Writable<Item[]> }>(
  (_, { items }) => {
    items.push({ title: "New", done: false });
    items.set(items.get().filter(x => !x.done));
  }
);
```

**Use `Writable<Array<Writable<T>>>` only when you need `.equals()` on elements:**

```typescript
import { handler, Writable } from 'commontools';

interface Item {
  title: string;
  done: boolean;
}

const removeItem = handler<
  unknown,
  { items: Writable<Array<Writable<Item>>>; item: Writable<Item> }
>((_, { items, item }) => {
  const index = items.get().findIndex(el => el.equals(item));
  if (index >= 0) items.set(items.get().toSpliced(index, 1));
});
```
