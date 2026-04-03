/// <cts-enable />
import { pattern, Writable, UI } from "commontools";

interface State {
  items: Array<{ name: string }>;
}

// FIXTURE: map-capture-writable-of
// Verifies: Writable.of() variable closed over in .map() is captured with asCell annotation
//   .map(fn) → .mapWithPattern(pattern(...), { selected: selected })
//   Writable.of<string | null>(null) → params.selected with { anyOf: [string, null], asCell: true }
export default pattern<State>((state) => {
  const selected = Writable.of<string | null>(null);
  return {
    [UI]: (
      <div>
        {state.items.map((item) => (
          <span>{item.name} {selected}</span>
        ))}
      </div>
    ),
  };
});
