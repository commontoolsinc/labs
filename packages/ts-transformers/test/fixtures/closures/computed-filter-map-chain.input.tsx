/// <cts-enable />
import { computed, pattern, UI } from "commontools";

interface Item {
  name: string;
  active: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: computed-filter-map-chain
// Verifies: .filter().map() chain inside computed() is NOT transformed
// Context: Inside computed(), OpaqueRef auto-unwraps to plain values, so
//   .filter() returns a plain JS array and .map() is Array.prototype.map.
//   Neither should become WithPattern variants. Same logic as derive.
export default pattern<State>((state) => {
  const names = computed(() =>
    state.items
      .filter((item) => item.active)
      .map((item) => item.name)
  );

  return {
    [UI]: <div>{names}</div>,
  };
});
