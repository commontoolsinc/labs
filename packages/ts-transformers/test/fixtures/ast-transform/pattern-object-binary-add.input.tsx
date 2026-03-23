/// <cts-enable />
import { pattern } from "commontools";

// FIXTURE: pattern-object-binary-add
// Verifies: top-level non-JSX arithmetic in an object property is lowered after
//   closure normalization into a direct derive wrapper rather than left as raw
//   arithmetic over opaque values.
//   return { next: state.count + 1 }
//   → return { next: derive(state.count + 1) }
export default pattern<{ count: number }>((state) => ({
  next: state.count + 1,
}));
