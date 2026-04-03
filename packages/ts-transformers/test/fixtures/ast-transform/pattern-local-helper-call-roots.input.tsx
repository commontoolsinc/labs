/// <cts-enable />
import { pattern } from "commontools";

const double = (x: number) => x * 2;

// FIXTURE: pattern-local-helper-call-roots
// Verifies: top-level ordinary local helper calls with reactive inputs are
//   lifted as whole calls, while plain inputs stay plain.
//   double(2)                 -> unchanged plain JS call
//   double(state.count + 1)   -> derive(..., ({ state }) => double(state.count + 1))
export default pattern<{ count: number }>((state) => ({
  staticDoubled: double(2),
  doubled: double(state.count + 1),
}));
