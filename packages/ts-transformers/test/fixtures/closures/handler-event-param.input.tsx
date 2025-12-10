/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  selectedValue: Cell<string>;
  changeCount: Cell<number>;
}

// Test typed event handler: ct-select has onct-change?: EventHandler<{ items: ...; value: ... }>
// The handler receives { detail: { items: [...], value: ... } }
export default pattern<State>((state) => {
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
