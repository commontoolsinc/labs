import * as __cfHelpers from "commonfabric";
import { cell } from "commonfabric";
declare function fetchAny(): any;
// FIXTURE: cell-value-any-recovery
// Verifies: direct `any` cell values emit a permissive `true` schema.
export const value = cell(fetchAny(), true as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
