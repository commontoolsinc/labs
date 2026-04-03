/// <cts-enable />
import { pattern, UI } from "commontools";

// FIXTURE: parameterized-inline-call-root
// Verifies: helper-owned parameterized inline-function call roots lower as a
// shared post-closure derive around the whole call, not as a derive inside the
// inline function body that leaves the reactive argument outside.
//   ((value) => prefix + value)(count)
//     -> derive(..., { prefix, count }, ({ prefix, count }) => ((value) => prefix + value)(count))
export default pattern<{ prefix: string; count: number }>(({ prefix, count }) => ({
  [UI]: <div>{((value: number) => prefix + value)(count)}</div>,
}));
