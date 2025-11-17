import * as __ctHelpers from "commontools";
import { NAME, OpaqueRef, recipe } from "commontools";
const count: OpaqueRef<number> = {} as any;
const _element = <div>{count}</div>;
export default recipe("test", false as const satisfies __ctHelpers.JSONSchema, (_state) => {
    return {
        [NAME]: "test",
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
