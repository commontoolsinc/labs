import { cell } from "commonfabric";

declare function fetchUnknown(): unknown;

// FIXTURE: cell-value-unknown-recovery
// Verifies: `unknown`-typed cells emit an explicit `{ type: "unknown" }` schema.
// Cell initials are schema defaults and must be compile-time static
// (CT-1880), so the runtime value arrives via `.set(...)` and the `unknown`
// comes from the explicit type argument.
export const value = cell<unknown>();
value.set(fetchUnknown());
