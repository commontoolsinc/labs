import { html } from "@commontools/common-html";
import { recipe, NAME, UI, handler, lift } from "@commontools/common-builder";

const inc = handler<{}, { count: { value: number } }>(({}, state) => {
  state.count.value += 1;
});

const updateRandomItem = handler<
  {},
  { items: { title: string; count: { value: number } }[] }
>(({}, state) => {
  state.items[Math.floor(Math.random() * state.items.length)].count.value += 1;
});

const addItem = handler<
  {},
  { items: { title: string; count: { value: number } }[] }
>(({}, state) => {
  state.items.push({
    title: `item ${state.items.length + 1}`,
    count: { value: 0 },
  });
});

const sum = lift(({ items }) =>
  items.reduce(
    (acc: number, item: { count: { value: number } }) => acc + item.count.value,
    0
  )
);

export const counters = recipe<{
  items: { title: string; count: { value: number } }[];
}>("counters", ({ items }) => {
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
              ${title} - ${count.value}
              <button onclick=${inc({ count })}>Inc</button>
            </li>`
        )}
      </ul>
      <p>Total: ${total}</p>
      <button onclick=${updateRandomItem({ items })}>Inc random item</button>
      <button onclick=${addItem({ items })}>Add new item</button>
    </div>`,
  };
});
