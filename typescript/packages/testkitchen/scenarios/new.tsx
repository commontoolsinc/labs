
import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
} from "@commontools/common-builder";
import { z } from "zod";

// Define counter schema
const Counter = z.object({ 
  title: z.string(),
  count: z.number(),
  kitty: z.string().default("🐱") // Add kitty field
});
type Counter = z.infer<typeof Counter>;

const Schema = z
  .object({
    items: z.array(Counter).default([]),
    title: z.string().default("Kitty Counters"), // Changed default title
  })
  .describe("Kitty Counters");
type Schema = z.infer<typeof Schema>;

// Handler to update title
const updateTitle = handler<{ detail: { value: string } }, { title: string }>(
  ({ detail }, state) => {
    detail?.value && (state.title = detail.value);
  },
);

// Handler to increment counter
const inc = handler<{}, { item: Counter }>(({}, { item }) => {
  item.count += 1;
});

// Handler to randomly increment a counter
const updateRandomItem = handler<{}, { items: Counter[] }>(({}, state) => {
  if (state.items.length > 0) {
    state.items[Math.floor(Math.random() * state.items.length)].count += 1;
  }
});

// Handler to add new counter
const addItem = handler<{}, { items: Counter[] }>(({}, state) => {
  state.items.push({ 
    title: `Kitty ${state.items.length + 1}`,
    count: 0,
    kitty: "🐱"
  });
});

// Handler to remove counter
const removeItem = handler<{}, { items: Counter[]; item: Counter }>(
  ({}, state) => {
    const index = state.items.findIndex((i) => i.title === state.item.title);
    state.items.splice(index, 1);
  },
);

// Lift to calculate total
const calculateTotal = lift(({ items }: { items: Counter[] }) =>
  items.reduce((acc, item) => acc + item.count, 0)
);

export default recipe(Schema, ({ items, title }) => {
  const total = calculateTotal({ items });

  return {
    [NAME]: str`${title}`,
    [UI]: (
      <os-container>
        <h1>
          <span role="img" aria-label="cat">🐱</span> 
          Kitty Counter Collection
          <span role="img" aria-label="cat">🐱</span>
        </h1>
        
        <common-input
          id="title"
          value={title}
          placeholder="Collection Title"
          oncommon-input={updateTitle({ title })}
        />

        {ifElse(
          items,
          <ul>
            {items.map((item) => (
              <li>
                <span role="img" aria-label="cat">{item.kitty}</span>
                {item.title} - <strong>{item.count}</strong>
                <button class="increment" onclick={inc({ item })}>
                  Pat the kitty (+1)
                </button>
                <button id="remove" onclick={removeItem({ item, items })}>
                  Remove kitty
                </button>
              </li>
            ))}
          </ul>,
          <p><em>No kitties yet! Add some with the button below.</em></p>
        )}

        <p>
          Total Kitty Pats: <span id="total">{total}</span>
        </p>

        <div class="controls">
          <button id="randomIncrement" onclick={updateRandomItem({ items })}>
            Pat Random Kitty
          </button>
          <button id="add" onclick={addItem({ items })}>
            Add New Kitty
          </button>
        </div>

        <style>
          {`
            os-container {
              padding: 20px;
              font-family: sans-serif;
            }
            h1 {
              text-align: center;
              color: #333;
            }
            ul {
              list-style: none;
              padding: 0;
            }
            li {
              margin: 10px 0;
              padding: 10px;
              border: 2px solid #eee;
              border-radius: 8px;
              display: flex;
              align-items: center;
              gap: 10px;
            }
            button {
              padding: 5px 10px;
              border-radius: 4px;
              border: none;
              cursor: pointer;
            }
            button.increment {
              background: #e0f7fa;
            }
            button#remove {
              background: #ffebee;
            }
            .controls {
              margin-top: 20px;
              display: flex;
              gap: 10px;
            }
            #total {
              font-weight: bold;
              color: #2196f3;
            }
          `}
        </style>
      </os-container>
    ),
  };
});