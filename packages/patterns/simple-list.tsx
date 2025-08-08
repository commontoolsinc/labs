/// <cts-enable />
import {
  Cell,
  Default,
  h,
  handler,
  NAME,
  recipe,
  toSchema,
  UI,
} from "commontools";

interface Item {
  title: string;
}

interface ListInput {
  title: Default<string, "My List">;
  items: Default<Item[], []>;
}

interface ListOutput extends ListInput {}

type MessageEvent = { detail: { message: string } };

const addItem = handler<MessageEvent, { items: Cell<Item[]> }>((e, state) => {
  const newItem = e.detail?.message?.trim();
  if (newItem) {
    const currentItems = state.items.get();
    state.items.set([...currentItems, { title: newItem }]);
  }
});

export default recipe(
  toSchema<ListInput>(),
  toSchema<ListOutput>(),
  ({ title, items }) => {
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
  },
);
