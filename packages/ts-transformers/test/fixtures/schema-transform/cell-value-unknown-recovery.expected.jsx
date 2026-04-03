import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
declare function fetchUnknown(): unknown;
// FIXTURE: cell-value-unknown-recovery
// Verifies: direct `unknown` cell values emit an explicit `{ type: "unknown" }` schema.
export const value = cell(fetchUnknown(), {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
