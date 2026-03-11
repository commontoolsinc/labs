/// <cts-enable />
import { pattern, UI } from "commontools";

// FIXTURE: map-jsx-compute-wrapper-local-function
// Verifies: .map() inside a non-reactive forEach is NOT transformed to mapWithPattern
//   forEach(() => list.map(...)) → derive() wrapping the entire forEach expression
// Context: Local function and reactive list inside forEach; whole block becomes a derive, not mapWithPattern
export default pattern<{ list: string[] }>(({ list }) => {
  return {
    [UI]: (
      <div>
        {[0, 1].forEach(() => {
          const project = (value: string) => value.toUpperCase();
          return list.map((item) => project(item));
        })}
      </div>
    ),
  };
});
