import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
  ModuleFactory,
  ifElse,
} from "@commontools/common-builder";
import { z } from "zod";

const Counter = z.object({ title: z.string(), count: z.number() });
type Counter = z.infer;

const CounterArray = z.array(Counter);
type CounterArray = z.infer;

const Counters = z
  .object({
    items: CounterArray.default([]),
    title: z.string().default("Counters"),
  })
  .describe("Counters");
type Counters = z.infer;

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => {
    console.log("updateValue", detail, state);
    detail?.value && (state.value = detail.value);
  },
);

const inc = handler<{}, { item: Counter }>(({}, { item }) => {
  item.count += 1;
});

const updateRandomItem = handler<{}, { items: Counter[] }>(({}, state) => {
  if (state.items.length > 0) {
    state.items[Math.floor(Math.random() * state.items.length)].count += 1;
  }
});

const addItem = handler<{}, { items: Counter[] }>(({}, state) => {
  state.items.push({ title: `item ${state.items.length + 1}`, count: 0 });
});

const removeItem = handler<{}, { items: Counter[]; item: Counter }>(
  ({}, state) => {
    // fixme(ja): findIndex doesn't work here
    // fixme(ja): filter doesn't work here
    const index = state.items.findIndex(i => i.title === state.item.title);
    state.items.splice(index, 1);
  },
);

const sum = lift(z.object({ items: CounterArray }), z.number(), ({ items }) =>
  items.reduce((acc: number, item: Counter) => acc + item.count, 0),
) as unknown as ModuleFactory;

export default recipe(Counters, ({ items, title }) => {
  const total = sum({ items });

  return {
    [NAME]: str`${title} counters`,
    [UI]: (
      <os-container>
        <common-input
          id="title"
          value={title}
          placeholder="Name of counter"
          oncommon-input={updateValue({ value: title })}
        />
        <ul>
          {items.map(item => (
            <li>
              {item.title} - {item.count}
              <button class="increment" onclick={inc({ item })}>
                inc
              </button>
              <button class="remove" onclick={removeItem({ item, items })}>
                remove
              </button>
            </li>
          ))}
        </ul>
        <p id="total">Total: {total}</p>
        <button id="randomIncrement" onclick={updateRandomItem({ items })}>
          Inc random item
        </button>
        <button id="add" onclick={addItem({ items })}>
          Add new item
        </button>
      </os-container>
    ),
    total,
  };
});
