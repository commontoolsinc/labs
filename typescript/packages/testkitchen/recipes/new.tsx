
import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
  ModuleFactory,
} from "@commontools/common-builder";
import { z } from "zod";

const Counter = z.object({ 
  title: z.string(), 
  count: z.number(),
  kitty: z.string().default("🐱") 
});
type Counter = z.infer<typeof Counter>;

const CounterArray = z.array(Counter);
type CounterArray = z.infer<typeof CounterArray>;

const Counters = z
  .object({
    items: CounterArray.default([]),
    title: z.string().default("Kitty Counters"),
  })
  .describe("Kitty Counters");
type Counters = z.infer<typeof Counters>;

const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    detail?.value && (state.title = detail.value);
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
  state.items.push({ 
    title: `Kitty ${state.items.length + 1}`, 
    count: 0,
    kitty: "🐱"
  });
});

const removeItem = handler<{}, { items: Counter[]; item: Counter }>(
  ({}, state) => {
    const index = state.items.findIndex(i => i.title === state.item.title);
    state.items.splice(index, 1);
  },
);

const calculateTotal = lift(z.object({ items: CounterArray }), z.number(), ({ items }) =>
  items.reduce((acc: number, item: Counter) => acc + item.count, 0),
) as unknown as ModuleFactory<{ items: CounterArray }, number>;

export default recipe(Counters, ({ items, title }) => {
  const total = calculateTotal({ items });

  return {
    [NAME]: str`${title}`,
    [UI]: (
      <os-container>
        <h1>
          <common-input
            id="title"
            value={title}
            placeholder="Collection Title" 
            oncommon-input={updateTitle({ title })}
          />
        </h1>

        {ifElse(
          items,
          <ul>
            {items.map(item => (
              <li>
                <span class="kitty">{item.kitty}</span>
                {item.title} - <span class="count">{item.count}</span>
                <button class="increment" onclick={inc({ item })}>
                  Pat the kitty
                </button>
                <button id="remove" onclick={removeItem({ item, items })}>
                  Goodbye kitty
                </button>
              </li>
            ))}
          </ul>,
          <p><em>No kitties yet! Add some with the button below.</em></p>
        )}

        <div class="controls">
          <p>Total Pats: <span id="total">{total}</span></p>
          
          <button id="randomIncrement" onclick={updateRandomItem({ items })}>
            Pat random kitty
          </button>
          
          <button id="add" onclick={addItem({ items })}>
            Adopt new kitty
          </button>
        </div>
      </os-container>
    ),
    total,
  };
});