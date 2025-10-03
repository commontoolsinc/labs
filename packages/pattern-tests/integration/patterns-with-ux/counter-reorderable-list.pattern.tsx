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

interface ReorderableListArgs {
  items: Default<number[], []>;
}

interface PositionState {
  index: number;
  value: number;
}

function normalizeItems(value: unknown): number[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is number =>
    typeof item === "number" && Number.isFinite(item)
  );
}

function initializeItems(cell: Cell<number[]>): number[] {
  const raw = cell.get();
  const normalized = normalizeItems(raw);
  if (
    !Array.isArray(raw) ||
    normalized.length !== raw.length ||
    normalized.some((item, index) => item !== raw[index])
  ) {
    cell.set(normalized);
  }
  return normalized;
}

function clampIndex(candidate: unknown, size: number): number {
  if (size <= 1) {
    return 0;
  }
  if (typeof candidate === "number" && Number.isFinite(candidate)) {
    const index = Math.trunc(candidate);
    if (index < 0) return 0;
    if (index >= size) return size - 1;
    return index;
  }
  return 0;
}

const reorderItems = handler(
  (
    event: { from?: number; to?: number } | undefined,
    context: { items: Cell<number[]> },
  ) => {
    const current = initializeItems(context.items);
    const length = current.length;
    if (length === 0) {
      return;
    }

    const fromIndex = clampIndex(event?.from, length);
    const toIndex = clampIndex(event?.to, length);
    if (fromIndex === toIndex) {
      return;
    }

    const next = current.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    context.items.set(next);
  },
);

const addItemHandler = handler(
  (
    _event: unknown,
    context: { items: Cell<number[]>; valueField: Cell<string> },
  ) => {
    const valueStr = context.valueField.get();
    if (typeof valueStr !== "string" || valueStr.trim() === "") {
      return;
    }

    const value = Number(valueStr.trim());
    if (!Number.isFinite(value)) {
      return;
    }

    const current = initializeItems(context.items);
    context.items.set([...current, value]);
    context.valueField.set("");
  },
);

const removeItemHandler = handler(
  (
    _event: unknown,
    context: { items: Cell<number[]>; indexField: Cell<string> },
  ) => {
    const indexStr = context.indexField.get();
    if (typeof indexStr !== "string" || indexStr.trim() === "") {
      return;
    }

    const index = Number(indexStr.trim());
    const current = initializeItems(context.items);
    if (!Number.isFinite(index) || index < 0 || index >= current.length) {
      return;
    }

    const next = current.slice();
    next.splice(Math.floor(index), 1);
    context.items.set(next);
    context.indexField.set("");
  },
);

const reorderHandler = handler(
  (
    _event: unknown,
    context: {
      items: Cell<number[]>;
      fromField: Cell<string>;
      toField: Cell<string>;
    },
  ) => {
    const fromStr = context.fromField.get();
    const toStr = context.toField.get();

    if (
      typeof fromStr !== "string" || fromStr.trim() === "" ||
      typeof toStr !== "string" || toStr.trim() === ""
    ) {
      return;
    }

    const current = initializeItems(context.items);
    const length = current.length;
    if (length === 0) {
      return;
    }

    const fromIndex = clampIndex(Number(fromStr.trim()), length);
    const toIndex = clampIndex(Number(toStr.trim()), length);
    if (fromIndex === toIndex) {
      return;
    }

    const next = current.slice();
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    context.items.set(next);
    context.fromField.set("");
    context.toField.set("");
  },
);

export const counterWithReorderableList = recipe<ReorderableListArgs>(
  "Counter With Reorderable List",
  ({ items }) => {
    const positions = derive(
      items,
      (values): PositionState[] =>
        normalizeItems(values).map((value, index) => ({ index, value })),
    );
    const size = lift((values: number[] | undefined) =>
      normalizeItems(values).length
    )(items);
    const orderText = derive(
      items,
      (values) => {
        const normalized = normalizeItems(values);
        if (normalized.length === 0) {
          return "(empty)";
        }
        return normalized.map((value) => `${value}`).join(" → ");
      },
    );

    // UI cells for form inputs
    const valueField = cell<string>("");
    const indexField = cell<string>("");
    const fromField = cell<string>("");
    const toField = cell<string>("");

    const name = str`Reorderable List (${size} items)`;

    const itemElements = lift((pos: PositionState[]) => {
      if (pos.length === 0) {
        return h(
          "div",
          {
            style:
              "padding: 2rem; text-align: center; color: #64748b; background: #f8fafc; border-radius: 0.5rem; font-style: italic;",
          },
          "No items in the list. Add some numbers to get started!",
        );
      }

      const elements = [];
      for (const p of pos) {
        const bgColor = p.index % 2 === 0 ? "#ffffff" : "#f1f5f9";
        elements.push(
          h(
            "div",
            {
              style: "display: flex; justify-content: space-between; " +
                "align-items: center; padding: 0.75rem 1rem; " +
                "background: " + bgColor + "; " +
                "border-bottom: 1px solid #e2e8f0;",
            },
            h(
              "span",
              {
                style:
                  "font-family: 'Courier New', monospace; font-weight: 600; color: #475569; min-width: 3rem;",
              },
              "[" + String(p.index) + "]",
            ),
            h(
              "span",
              {
                style:
                  "font-family: 'Courier New', monospace; font-size: 1.25rem; font-weight: 700; color: #0f172a;",
              },
              String(p.value),
            ),
          ),
        );
      }
      return h("div", {
        style:
          "border: 1px solid #cbd5e1; border-radius: 0.5rem; overflow: hidden;",
      }, ...elements);
    })(positions);

    const ui = (
      <div style="max-width: 48rem; margin: 0 auto; padding: 1.5rem;">
        <div style="margin-bottom: 2rem;">
          <h2 style="font-size: 1.5rem; font-weight: 700; color: #0f172a; margin: 0 0 0.5rem 0;">
            Reorderable List
          </h2>
          <p style="color: #64748b; margin: 0;">
            Manage a list of numbers and reorder them by moving items from one
            index to another.
          </p>
        </div>

        <div style="margin-bottom: 1.5rem; padding: 1rem; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); border-radius: 0.5rem;">
          <div style="font-size: 0.75rem; font-weight: 600; color: #e0e7ff; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem;">
            Current Order
          </div>
          <div
            style="font-family: 'Courier New', monospace; font-size: 1.125rem; font-weight: 600; color: #ffffff;"
            innerHTML={orderText}
          />
          <div style="margin-top: 0.5rem; font-size: 0.875rem; color: #c7d2fe;">
            {size} {lift((s: number) => s === 1 ? "item" : "items")(size)}
          </div>
        </div>

        <div style="display: grid; gap: 1rem; grid-template-columns: 1fr 1fr;">
          <div style="padding: 1.25rem; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 0.5rem;">
            <h3 style="font-size: 1rem; font-weight: 600; color: #0f172a; margin: 0 0 1rem 0;">
              Add Item
            </h3>
            <div style="display: flex; gap: 0.5rem;">
              <ct-input
                $value={valueField}
                placeholder="Enter number"
                style="flex: 1;"
              />
              <ct-button
                onClick={addItemHandler({ items, valueField })}
                variant="primary"
              >
                Add
              </ct-button>
            </div>
          </div>

          <div style="padding: 1.25rem; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 0.5rem;">
            <h3 style="font-size: 1rem; font-weight: 600; color: #0f172a; margin: 0 0 1rem 0;">
              Remove Item
            </h3>
            <div style="display: flex; gap: 0.5rem;">
              <ct-input
                $value={indexField}
                placeholder="Enter index"
                style="flex: 1;"
              />
              <ct-button
                onClick={removeItemHandler({ items, indexField })}
                variant="danger"
              >
                Remove
              </ct-button>
            </div>
          </div>
        </div>

        <div style="margin-top: 1rem; padding: 1.25rem; background: #ffffff; border: 1px solid #cbd5e1; border-radius: 0.5rem;">
          <h3 style="font-size: 1rem; font-weight: 600; color: #0f172a; margin: 0 0 1rem 0;">
            Reorder Items
          </h3>
          <div style="display: grid; gap: 0.5rem; grid-template-columns: 1fr 1fr auto;">
            <ct-input
              $value={fromField}
              placeholder="From index"
            />
            <ct-input
              $value={toField}
              placeholder="To index"
            />
            <ct-button
              onClick={reorderHandler({ items, fromField, toField })}
              variant="primary"
            >
              Move
            </ct-button>
          </div>
          <div style="margin-top: 0.75rem; font-size: 0.875rem; color: #64748b;">
            Move an item from one position to another. The item at "from" index
            will be inserted at "to" index.
          </div>
        </div>

        <div style="margin-top: 1.5rem;">
          <h3 style="font-size: 1rem; font-weight: 600; color: #0f172a; margin: 0 0 1rem 0;">
            List Items
          </h3>
          {itemElements}
        </div>
      </div>
    );

    return {
      items,
      positions,
      size,
      label: str`Order: ${orderText}`,
      reorder: reorderItems({ items }),
      [NAME]: name,
      [UI]: ui,
    };
  },
);
