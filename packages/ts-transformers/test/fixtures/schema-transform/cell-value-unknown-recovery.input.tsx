/// <cts-enable />
import { cell } from "commontools";

declare function fetchUnknown(): unknown;

// FIXTURE: cell-value-unknown-recovery
// Verifies: direct `unknown` cell values emit an explicit `{ type: "unknown" }` schema.
export const value = cell(fetchUnknown());
