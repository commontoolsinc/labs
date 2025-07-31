import {
  Cell,
  derive,
  h,
  handler,
  JSONSchema,
  NAME,
  recipe,
  Schema,
  UI,
} from "commontools";

const ItemSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
  },
  required: ["title"],
} as const satisfies JSONSchema;

const ListSchema = {
  type: "object",
  properties: {
    title: {
      type: "string",
      default: "My List",
      asCell: true,
    },
    items: {
      type: "array",
      items: ItemSchema,
      default: [],
      asCell: true,
    },
  },
  required: ["title", "items"],
} as const satisfies JSONSchema;

const ResultSchema = {
  type: "object",
  properties: {
    title: { type: "string" },
    items: { type: "array", items: ItemSchema },
  },
  required: ["title", "items"],
} as const satisfies JSONSchema;

// // Handler to add new items
// const addItem = handler<
//   { detail: { message: string } },
//   { items: Cell<(typeof ItemSchema)[]> }
// >((event, { items }) => {
//   const newItem = event.detail?.message?.trim();
//   if (newItem) {
//     const currentItems = items.get();
//     items.set([...currentItems, { title: newItem }]);
//   }
// });

const addItem = handler(
  {
    type: "object",
    properties: {
      detail: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
      },
    },
    required: ["detail"],
  },
  {
    type: "object",
    properties: {
      items: { type: "array", items: ItemSchema, asCell: true },
    },
    required: ["items"],
  },
  (e, state) => {
    const newItem = e.detail?.message?.trim();
    if (newItem) {
      const currentItems = state.items.get();
      state.items.set([...currentItems, { title: newItem }]);
    }
  },
);

// Handler to delete an item
const deleteItem = handler(
  {
    type: "object",
    properties: {
      detail: {
        type: "object",
        properties: {
          item: {
            type: "object",
            properties: { title: { type: "string" } },
            required: ["title"],
            asCell: true,
          },
        },
        required: ["item"],
      },
    },
    required: ["detail"],
  },
  {
    type: "object",
    properties: {
      items: { type: "array", items: ItemSchema, asCell: true },
    },
    required: ["items"],
  },
  ({ detail }, { items }) => {
    console.log("TO DELETE", detail.item);
    const idx = findCellIndex(items, detail.item);
    console.log("DELETING ITEM", idx);
    console.log("next", items.get().filter((item, i) => i !== idx))
    items.set(items.get().filter((item, i) => i !== idx));
  },
);

function findCellIndex<T>(listCell: Cell<T[]>, itemCell: Cell<T>): number {
  const length = listCell.get().length;
  for (let i = 0; i < length; i++) {
    if (itemCell.equals(listCell.key(i))) {
      return i;
    }
  }
  return -1;
}

export default recipe(ListSchema, ResultSchema, ({ title, items }) => {
  return {
    [NAME]: title,
    [UI]: (
      <common-vstack gap="md" style="padding: 1rem; max-width: 600px;">
        <ct-input
          $value={title}
          placeholder="List title"
          customStyle="font-size: 24px; font-weight: bold;"
        />

        <ct-card>
          <common-vstack gap="sm">
            <ct-list
              $value={items}
              editable
              title="Items"
              onct-remove-item={deleteItem({ items })}
            />
          </common-vstack>
        </ct-card>
      </common-vstack>
    ),
    title,
    items,
  };
});
