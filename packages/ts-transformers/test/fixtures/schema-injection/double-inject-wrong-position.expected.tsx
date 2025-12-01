import * as __ctHelpers from "commontools";
import { cell } from "commontools";
const schema = { type: "number" } as const;
export default function TestDoubleInjectWrongPosition() {
    // Should NOT transform - already has 2 arguments (even if in wrong order)
    // This is malformed code, but we shouldn't make it worse by adding a third arg
    // @ts-expect-error Testing transformer handles invalid argument order gracefully
    const _c1 = cell(schema, 10);
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
