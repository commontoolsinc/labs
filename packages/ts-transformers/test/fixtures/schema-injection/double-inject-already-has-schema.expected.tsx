import * as __ctHelpers from "commontools";
import { cell } from "commontools";
const existingSchema = { type: "number" } as const;
export default function TestDoubleInjectAlreadyHasSchema() {
    // Should NOT transform - already has 2 arguments
    const _c1 = cell(10, existingSchema);
    const _c2 = cell("hello", { type: "string" });
    const _c3 = cell(true, { type: "boolean" } as const);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
