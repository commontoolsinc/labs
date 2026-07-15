import { cell } from "commonfabric";

declare function fetchAny(): any;

// FIXTURE: cell-value-any-recovery
// Verifies: `any`-typed cells emit a permissive `true` schema.
// Cell initials are schema defaults and must be compile-time static
// (CT-1880), so the runtime value arrives via `.set(...)` and the `any`
// comes from the explicit type argument.
export const value = cell<any>();
value.set(fetchAny());
