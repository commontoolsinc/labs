import { h } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift } from "@commontools/common-builder";

const inc = handler<{}, { count: number }>(({}, state) => {
  state.count += 1;
});

const updateRandomItem = handler<
  {},
  { items: { title: string; count: number }[] }
>(({}, state) => {
  // TODO(ja): if a handler throws an exception recipes
  // seems to stop updating / future handlers are not called.
  if (state.items.length > 0) {
    state.items[Math.floor(Math.random() * state.items.length)].count += 1;
  }
});

const addItem = handler<{}, { items: { title: string; count: number }[] }>(
  ({}, state) => {
    state.items.push({ title: `item ${state.items.length + 1}`, count: 0 });
  }
);

const sum = lift(({ items }) =>
  items.reduce((acc: number, item: { count: number }) => acc + item.count, 0)
);

export const counters = recipe<{ items: { title: string; count: number }[] }>(
  "counters",
  ({ items }) => {
    items.setDefault([]);

    const total = sum({ items });

    return {
      [NAME]: "counters",
      [UI]: <div>
        <ul>
          {items.map(
            ({ title, count }) =>
              <li>
                {title} - {count}
                <button onclick={inc({ count })}>Inc</button>
              </li>
          )}
        </ul>
        <p>Total: {total}</p>
        <button onclick={updateRandomItem({ items })}>Inc random item</button>
        <button onclick={addItem({ items })}>Add new item</button>
      </div>,
    };
  }
);
