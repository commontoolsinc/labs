import { pattern, UI, Writable } from "commonfabric";

const COLORS = ["red", "green", "blue"];

interface Input {
  selected: Writable<string>;
}

// FIXTURE: map-plain-array-inline-handler
// Verifies: an inline handler inside a plain-array .map() captures that
// iteration's element, so each rendered node carries its own handler
//   COLORS.map(fn)                          -> plain .map() remains plain
//   onClick={() => selected.set(color)}     -> hoisted handler factory applied
//                                              per element, capturing `color`
//                                              and `selected`
// Context: The render-loop shape authored patterns use after moving away from
// pre-built action arrays — the per-element binding is what a shared or
// last-one-wins handler would silently break, and it is otherwise pinned only
// by live pattern runs
export default pattern<Input>(({ selected }) => {
  return {
    [UI]: (
      <div>
        {COLORS.map((color) => (
          <button type="button" onClick={() => selected.set(color)}>
            {color}
          </button>
        ))}
      </div>
    ),
  };
});
