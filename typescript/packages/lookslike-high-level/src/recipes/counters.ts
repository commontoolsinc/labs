import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift } from "@commontools/common-builder";

const inc = handler<{}, { count: number }>(({}, state) => {
  state.count += 1;
});

const updateRandomItem = handler<
  {},
  { items: { title: string; count: number }[] }
>(({}, state) => {
  state.items[Math.floor(Math.random() * state.items.length)].count += 1;
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
    //items.setDefault([{ title: "item 1", count: 0 }, { title: "item 2", count: 0 }]);

    const total = sum({ items });

    return {
      [NAME]: "counters",
      [UI]: html`<div>
        <ul>
          ${items.map(
            ({ title, count }) =>
              html`<li>
                ${title} - ${count}
                <button onclick=${inc({ count })}>Inc</button>
              </li>`
          )}
        </ul>
        <p>Total: ${total}</p>
        <button onclick=${updateRandomItem({ items })}>Inc random item</button>
        <button onclick=${addItem({ items })}>Add new item</button>
      </div>`,
    };
  }
);
