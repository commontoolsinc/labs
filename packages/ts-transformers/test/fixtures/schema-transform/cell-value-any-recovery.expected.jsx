import * as __ctHelpers from "commontools";
import { cell } from "commontools";
declare function fetchAny(): any;
// FIXTURE: cell-value-any-recovery
// Verifies: direct `any` cell values emit a permissive `true` schema.
export const value = cell(fetchAny(), true as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
