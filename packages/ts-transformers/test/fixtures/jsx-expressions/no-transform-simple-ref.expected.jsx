import * as __ctHelpers from "commontools";
import { NAME, OpaqueRef, pattern } from "commontools";
const count: OpaqueRef<number> = {} as any;
const _element = <div>{count}</div>;
export default pattern((_state) => {
    return {
        [NAME]: "test",
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        }
    },
    required: ["$NAME"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
