/// <cts-enable />
import { h, handler, JSONSchema, NAME, recipe, UI } from "commontools";

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

// Example of a handler to add to the list manually, if you set `readonly` the list will lose its in-built add form
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
            />
          </common-vstack>
        </ct-card>
      </common-vstack>
    ),
    title,
    items,
  };
});
