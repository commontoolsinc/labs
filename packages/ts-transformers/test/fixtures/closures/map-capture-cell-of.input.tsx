/// <cts-enable />
import { Cell, pattern, UI } from "commontools";

interface State {
  items: Array<{ name: string }>;
}

// FIXTURE: map-capture-cell-of
// Verifies: Cell.of() variable closed over in .map() is captured with asCell schema annotation
//   .map(fn) → .mapWithPattern(pattern(...), { counter: counter })
//   Cell.of(0) capture → params.counter with { type: "number", asCell: true }
export default pattern<State>((state) => {
  const counter = Cell.of(0);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} #{counter}</span>
        ))}
      </div>
    ),
  };
});
