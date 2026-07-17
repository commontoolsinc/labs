import { Cell, lift } from "commonfabric";

// FIXTURE: map-cell-receiver-in-lift
// Verifies: compute-owned map roots on Cell receivers still lower to mapWithPattern
//   lift(() => items.map((item) => item)) -> lift(() => items.mapWithPattern(...)).
// The zero-param callback derives from a CAPTURED module-scope cell, so the
// W2.13 capture-freeness gate (FB2) withholds the scheduler certificate.
// Context: No JSX here; the map rewrite happens inside a builder-owned compute context
const items = new Cell<string[]>([]);

export const fn = lift(() => items.map((item) => item));
