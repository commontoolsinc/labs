/// <cts-enable />
import { Cell, recipe, UI } from "commontools";

interface State {
  selectedValue: Cell<string>;
  lastItems: Cell<string>;
}

// Test destructured event handler params with typed ct-select onct-change
export default recipe<State>("Destructure", (state) => {
  return {
    [UI]: (
      <ct-select
        $value={state.selectedValue}
        items={[
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
        ]}
        onct-change={({ detail: { value, items } }) => {
          state.selectedValue.set(value);
          state.lastItems.set(items.map(i => i.label).join(", "));
        }}
      />
    ),
  };
});
