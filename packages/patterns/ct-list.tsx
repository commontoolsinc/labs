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

export default recipe<ListInput, ListOutput>(
  "ct-list demo",
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
            <ct-list
              $value={items}
              editable
              title="Items"
            />
          </ct-card>
        </common-vstack>
      ),
      title,
      items,
    };
  },
);
