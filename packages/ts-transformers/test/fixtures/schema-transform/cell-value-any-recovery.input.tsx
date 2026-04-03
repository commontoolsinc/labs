/// <cts-enable />
import { cell } from "commontools";

declare function fetchAny(): any;

// FIXTURE: cell-value-any-recovery
// Verifies: direct `any` cell values emit a permissive `true` schema.
export const value = cell(fetchAny());
