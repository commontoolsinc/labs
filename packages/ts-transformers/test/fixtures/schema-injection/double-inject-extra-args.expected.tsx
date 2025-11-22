import * as __ctHelpers from "commontools";
import { cell } from "commontools";
const schema = { type: "number" } as const;
const extra = "extra";
export default function TestDoubleInjectExtraArgs() {
    // Should NOT transform - already has more than 2 arguments
    // This is malformed code, but we shouldn't touch it
    const _c1 = cell(10, schema, extra);
    const _c2 = cell(20, schema, extra, "another");
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
