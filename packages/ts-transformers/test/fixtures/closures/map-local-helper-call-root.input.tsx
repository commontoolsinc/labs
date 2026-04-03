/// <cts-enable />
import { pattern } from "commontools";

const identity = <T,>(value: T) => value;

// FIXTURE: map-local-helper-call-root
// Verifies: non-JSX pattern-owned map callbacks lift ordinary local helper
//   calls as whole callback-local derives rather than lowering only the inner
//   receiver-method argument expression.
//   items.map((item) => identity(item.toUpperCase()))
//   -> mapWithPattern(..., ({ item }) => derive(..., ({ item }) => identity(item.toUpperCase())))
export default pattern<{ items: string[] }>(({ items }) =>
  items.map((item) => identity(item.toUpperCase()))
);
