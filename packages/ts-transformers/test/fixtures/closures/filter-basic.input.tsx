/// <cts-enable />
import { pattern, UI } from "commontools";

interface Item {
  name: string;
  active: boolean;
}

interface State {
  items: Item[];
}

// FIXTURE: filter-basic
// Verifies: .filter() and .map() on reactive arrays are both transformed
//   .filter(fn) → .filterWithPattern(pattern(...), {})
//   .map(fn)    → .mapWithPattern(pattern(...), {})
// Context: No captured outer variables — params objects are empty {}
export default pattern<State>((state) => {
  return {
    [UI]: (
      <ul>
        {state.items.filter((item) => item.active).map((item) => (
          <li>{item.name}</li>
        ))}
      </ul>
    ),
  };
});
