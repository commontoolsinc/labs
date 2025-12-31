/// <cts-enable />
import { computed, ifElse, UI, recipe, Cell } from "commontools";

interface Item {
  id: string;
  name: string;
}

interface State {
  items: Item[];
  editingId: Cell<string>;
}

export default recipe<State>("EditableList", (state) => {
  return {
    [UI]: (
      <ul>
        {state.items.map((item) => (
          <li>
            {ifElse(
              computed(() => state.editingId.get() === item.id),
              <input value={item.name} />,
              <span>{item.name}</span>
            )}
          </li>
        ))}
      </ul>
    ),
  };
});
