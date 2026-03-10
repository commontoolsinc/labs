import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
export default pattern(() => {
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Input name collides with capture name
    // multiplier is both the input AND a captured variable (used via .get())
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            multiplier: {
                type: "number",
                asCell: true
            },
            multiplier_1: {
                type: "number",
                asCell: true
            }
        },
        required: ["multiplier", "multiplier_1"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        multiplier,
        multiplier_1: multiplier
    }, ({ multiplier: m, multiplier_1 }) => m.get() * 3 + multiplier_1.get());
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
