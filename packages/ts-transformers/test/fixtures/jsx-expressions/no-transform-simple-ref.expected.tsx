import * as __ctHelpers from "commontools";
import { recipe, NAME, OpaqueRef, h } from "commontools";
const count: OpaqueRef<number> = {} as any;
const element = <div>{count}</div>;
export default recipe("test", (state) => {
    return {
        [NAME]: "test",
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
