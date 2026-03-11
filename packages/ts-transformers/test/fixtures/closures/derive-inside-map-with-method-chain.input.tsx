/// <cts-enable />
import { derive, pattern, UI } from "commontools";

interface SubItem {
  id: number;
  name: string;
  active: boolean;
}

interface Item {
  id: number;
  title: string;
  subItems: SubItem[];
}

interface State {
  items: Item[];
}

// FIXTURE: derive-inside-map-with-method-chain
// Verifies: derive nested inside .map() correctly transforms outer .map() but leaves inner chains alone
//   state.items.map(fn) → state.items.mapWithPattern(pattern(...))
//   inner .filter().map() inside derive callback → NOT transformed (plain array)
// Context: derive is used inline in JSX within a mapWithPattern callback
export default pattern<State>((state) => {
  return {
    [UI]: (
      <div>
        {/* Edge case: explicit derive inside mapWithPattern with method chain.
            The inner .filter().map() should NOT be transformed because:
            - subs is a derive callback parameter (unwrapped at runtime)
            - .filter() returns a plain JS array
            - Plain arrays don't have .mapWithPattern() */}
        {state.items.map((item) => (
          <div>
            <h2>{item.title}</h2>
            <p>
              Active items:{" "}
              {derive(item.subItems, (subs) =>
                subs
                  .filter((s) => s.active)
                  .map((s) => s.name)
                  .join(", ")
              )}
            </p>
          </div>
        ))}
      </div>
    ),
  };
});
