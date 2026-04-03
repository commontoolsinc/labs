/// <cts-enable />
import { pattern } from "commontools";

// FIXTURE: pattern-object-prefix-not
// Verifies: top-level non-JSX unary boolean negation in an object property is
//   lowered after closure normalization into a direct derive wrapper.
//   return { hidden: !state.done }
//   → return { hidden: derive(!state.done) }
export default pattern<{ done: boolean }>((state) => ({
  hidden: !state.done,
}));
