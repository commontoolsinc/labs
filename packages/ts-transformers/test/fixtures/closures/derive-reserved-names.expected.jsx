import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Reserved JavaScript keyword as variable name (valid in TS with quotes)
    const __ct_reserved = Writable.of(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            __ct_reserved: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "__ct_reserved"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        __ct_reserved: __ct_reserved
    }, ({ value: v, __ct_reserved }) => v.get() * __ct_reserved.get());
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
