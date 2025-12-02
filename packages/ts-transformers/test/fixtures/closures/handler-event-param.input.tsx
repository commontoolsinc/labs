/// <cts-enable />
import { Cell, recipe, UI } from "commontools";

interface State {
  selectedValue: Cell<string>;
  changeCount: Cell<number>;
}

// Test typed event handler: ct-select has onct-change?: EventHandler<{ items: ...; value: ... }>
// The handler receives { detail: { items: [...], value: ... } }
export default recipe<State>("SelectTracker", (state) => {
  return {
    [UI]: (
      <ct-select
        $value={state.selectedValue}
        items={[
          { label: "Option A", value: "a" },
          { label: "Option B", value: "b" },
        ]}
        onct-change={(event) => {
          state.selectedValue.set(event.detail.value);
          state.changeCount.set(state.changeCount.get() + 1);
        }}
      />
    ),
  };
});
