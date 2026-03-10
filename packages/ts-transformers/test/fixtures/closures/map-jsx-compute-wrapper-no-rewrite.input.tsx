/// <cts-enable />
import { pattern, UI } from "commontools";

// FIXTURE: map-jsx-compute-wrapper-no-rewrite
// Verifies: .map() nested inside a non-reactive forEach is NOT rewritten to mapWithPattern
//   forEach(() => list.map(...)) → derive() wrapping the entire expression
// Context: NEGATIVE TEST for mapWithPattern -- the .map() is inside forEach, so only derive is emitted
export default pattern<{ list: string[] }>(({ list }) => {
  return {
    [UI]: <div>{[0, 1].forEach(() => list.map((item) => item))}</div>,
  };
});
