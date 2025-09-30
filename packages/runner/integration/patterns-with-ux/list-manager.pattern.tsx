/// <cts-enable />
// @ts-nocheck
import {
  type Cell,
  cell,
  compute,
  Default,
  derive,
  h,
  handler,
  lift,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";

interface Item {
  label: string;
  count: number;
}

interface ListManagerArgs {
  items: Default<Item[], []>;
}

const addItemHandler = handler(
  (
    _event: unknown,
    context: {
      items: Cell<Item[]>;
      labelField: Cell<string>;
      countField: Cell<string>;
    },
  ) => {
    const label = context.labelField.get() || "untitled";
    const countText = context.countField.get() || "0";
    const count = Number(countText);
    const sanitizedCount = Number.isFinite(count) ? Math.trunc(count) : 0;

    context.items.push({ label, count: sanitizedCount });
    context.labelField.set("");
    context.countField.set("0");
  },
);

const incrementItemHandler = handler(
  (
    _event: unknown,
    context: {
      items: Cell<Item[]>;
      indexField: Cell<string>;
      amountField: Cell<string>;
    },
  ) => {
    const indexText = context.indexField.get() || "0";
    const index = Number(indexText);
    const sanitizedIndex = Number.isFinite(index) ? Math.trunc(index) : 0;

    const amountText = context.amountField.get() || "1";
    const amount = Number(amountText);
    const sanitizedAmount = Number.isFinite(amount) ? Math.trunc(amount) : 1;

    const itemsArray = context.items.get() || [];
    if (sanitizedIndex >= 0 && sanitizedIndex < itemsArray.length) {
      const target = context.items.key(sanitizedIndex) as Cell<Item>;
      const countCell = target.key("count");
      const current = countCell.get() ?? 0;
      countCell.set(current + sanitizedAmount);
    }
  },
);

export const listManagerUx = recipe<ListManagerArgs>(
  "List Manager (UX)",
  ({ items }) => {
    const size = lift((collection: Item[]) => collection.length)(items);
    const names = derive(
      items,
      (collection) => collection.map((item) => item.label),
    );

    const labelField = cell<string>("");
    const countField = cell<string>("0");
    const indexField = cell<string>("0");
    const amountField = cell<string>("1");

    const addItem = addItemHandler({ items, labelField, countField });
    const incrementItem = incrementItemHandler({
      items,
      indexField,
      amountField,
    });

    const summary = str`Items: ${size}`;
    const name = str`List Manager (${size} items)`;

    const isEmpty = lift((count: number) => count === 0)(size);

    const itemsList = lift((collection: Item[]) => {
      if (!collection || collection.length === 0) {
        return (
          <div style="
              padding: 2rem;
              text-align: center;
              color: #94a3b8;
              font-size: 0.9rem;
            ">
            No items added yet. Add your first item above.
          </div>
        );
      }

      const elements = [];
      for (let i = 0; i < collection.length; i++) {
        const item = collection[i];
        const bgColor = i % 2 === 0 ? "#f8fafc" : "#ffffff";
        const indexColor = "#64748b";
        const labelStyle =
          "font-weight: 500; color: #0f172a; font-size: 0.95rem;";
        const countStyle =
          "background: #e0e7ff; color: #4338ca; padding: 0.25rem 0.75rem; border-radius: 1rem; font-size: 0.85rem; font-weight: 600; font-family: monospace;";

        elements.push(
          <div
            key={String(i)}
            style={"display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1rem; background: " +
              bgColor +
              "; border-bottom: 1px solid #e2e8f0;"}
          >
            <span
              style={"font-size: 0.75rem; color: " +
                indexColor +
                "; min-width: 1.5rem; text-align: center; font-family: monospace;"}
            >
              {String(i)}
            </span>
            <span style={labelStyle}>{item.label}</span>
            <div style="flex: 1;"></div>
            <span style={countStyle}>{String(item.count)}</span>
          </div>,
        );
      }

      return (
        <div style="border-radius: 0.5rem; overflow: hidden;">{elements}</div>
      );
    })(items);

    return {
      [NAME]: name,
      [UI]: (
        <div style="
            display: flex;
            flex-direction: column;
            gap: 1.5rem;
            max-width: 40rem;
          ">
          <ct-card>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 1.25rem;
              "
            >
              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.25rem;
                ">
                <span style="
                    color: #475569;
                    font-size: 0.75rem;
                    letter-spacing: 0.08em;
                    text-transform: uppercase;
                  ">
                  List Manager
                </span>
                <h2 style="
                    margin: 0;
                    font-size: 1.3rem;
                    color: #0f172a;
                  ">
                  Manage a collection of labeled items with counts
                </h2>
              </div>

              <div style="
                  background: #f0f9ff;
                  border-left: 4px solid #0ea5e9;
                  padding: 1rem;
                  border-radius: 0.5rem;
                ">
                <div style="
                    display: flex;
                    justify-content: space-between;
                    align-items: baseline;
                  ">
                  <span style="font-size: 0.85rem; color: #0369a1;">
                    Total items
                  </span>
                  <strong style="font-size: 1.75rem; color: #0c4a6e;">
                    {size}
                  </strong>
                </div>
              </div>

              <div style="
                  display: flex;
                  flex-direction: column;
                  gap: 0.75rem;
                ">
                <h3 style="
                    margin: 0;
                    font-size: 0.95rem;
                    font-weight: 600;
                    color: #334155;
                  ">
                  Add new item
                </h3>
                <div style="
                    display: grid;
                    grid-template-columns: 2fr 1fr;
                    gap: 0.75rem;
                  ">
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="item-label"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Label
                    </label>
                    <ct-input
                      id="item-label"
                      type="text"
                      placeholder="Enter item label"
                      $value={labelField}
                      aria-label="Item label"
                    >
                    </ct-input>
                  </div>
                  <div style="
                      display: flex;
                      flex-direction: column;
                      gap: 0.4rem;
                    ">
                    <label
                      for="item-count"
                      style="
                        font-size: 0.85rem;
                        font-weight: 500;
                        color: #334155;
                      "
                    >
                      Count
                    </label>
                    <ct-input
                      id="item-count"
                      type="number"
                      step="1"
                      $value={countField}
                      aria-label="Item count"
                    >
                    </ct-input>
                  </div>
                </div>
                <ct-button
                  onClick={addItem}
                  aria-label="Add item to list"
                >
                  Add item
                </ct-button>
              </div>
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Items list
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0;
              "
            >
              {itemsList}
            </div>
          </ct-card>

          <ct-card>
            <div
              slot="header"
              style="
                display: flex;
                justify-content: space-between;
                align-items: center;
              "
            >
              <h3 style="margin: 0; font-size: 1rem; color: #0f172a;">
                Increment item
              </h3>
            </div>
            <div
              slot="content"
              style="
                display: flex;
                flex-direction: column;
                gap: 0.75rem;
              "
            >
              <div style="
                  display: grid;
                  grid-template-columns: 1fr 1fr;
                  gap: 0.75rem;
                ">
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="item-index"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Item index
                  </label>
                  <ct-input
                    id="item-index"
                    type="number"
                    step="1"
                    min="0"
                    $value={indexField}
                    aria-label="Index of item to increment"
                  >
                  </ct-input>
                </div>
                <div style="
                    display: flex;
                    flex-direction: column;
                    gap: 0.4rem;
                  ">
                  <label
                    for="increment-amount"
                    style="
                      font-size: 0.85rem;
                      font-weight: 500;
                      color: #334155;
                    "
                  >
                    Amount
                  </label>
                  <ct-input
                    id="increment-amount"
                    type="number"
                    step="1"
                    $value={amountField}
                    aria-label="Amount to increment"
                  >
                  </ct-input>
                </div>
              </div>
              <ct-button
                variant="secondary"
                onClick={incrementItem}
                aria-label="Increment item count"
              >
                Increment item
              </ct-button>
            </div>
          </ct-card>

          <div
            role="status"
            aria-live="polite"
            data-testid="status"
            style="font-size: 0.85rem; color: #475569;"
          >
            {summary}
          </div>
        </div>
      ),
      summary,
      items,
      names,
      size,
      controls: {
        addItem,
        incrementItem,
      },
    };
  },
);

export default listManagerUx;
