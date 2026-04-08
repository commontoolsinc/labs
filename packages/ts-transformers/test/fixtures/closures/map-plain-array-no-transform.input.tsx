import { pattern, UI } from "commonfabric";

interface State {
  multiplier: number;
}

// FIXTURE: map-plain-array-no-transform
// Verifies: .map() on a plain (non-reactive) array is NOT transformed to mapWithPattern
//   plainArray.map(fn) → plainArray.map(fn) (unchanged)
//   nested JSX-local reactive expressions inside the callback still lower via derive()
// Context: NEGATIVE TEST for callback-root ownership -- the array is a local literal [1,2,3,4,5], not a reactive Cell array
export default pattern<State>((state) => {
  const plainArray = [1, 2, 3, 4, 5];

  return {
    [UI]: (
      <div>
        {/* Plain array should NOT be transformed, even with captures */}
        {plainArray.map((n) => (
          <span>{n * state.multiplier}</span>
        ))}
      </div>
    ),
  };
});
