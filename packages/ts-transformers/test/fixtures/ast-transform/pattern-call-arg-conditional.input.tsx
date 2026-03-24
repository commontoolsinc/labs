/// <cts-enable />
import { pattern } from "commontools";

const identity = <T,>(value: T) => value;

// FIXTURE: pattern-call-arg-conditional
// Verifies: top-level non-JSX ternary in a call argument is lowered after
//   closure normalization rather than being left as raw JS truthiness.
//   const label = identity(state.done ? "Done" : "Pending")
//   → const label = identity(ifElse(state.done, "Done", "Pending"))
export default pattern<{ done: boolean }>((state) => {
  const label = identity(state.done ? "Done" : "Pending");
  return { label };
});
