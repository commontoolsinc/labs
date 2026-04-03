import * as __ctHelpers from "commontools";
import { cell } from "commontools";
declare function fetchUnknown(): unknown;
// FIXTURE: cell-value-unknown-recovery
// Verifies: direct `unknown` cell values emit an explicit `{ type: "unknown" }` schema.
export const value = cell(fetchUnknown(), {
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
