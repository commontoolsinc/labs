/// <cts-enable />
import { pattern } from "commontools";

const wrap = <T,>(value: T) => value;

// FIXTURE: pattern-call-arg-conditional
// Verifies: top-level non-JSX ternary in a call argument is lowered after
//   closure normalization rather than being left as raw JS truthiness.
//   const label = wrap(state.done ? "Done" : "Pending")
//   → const label = wrap(ifElse(state.done, "Done", "Pending"))
export default pattern<{ done: boolean }>((state) => {
  const label = wrap(state.done ? "Done" : "Pending");
  return { label };
});
