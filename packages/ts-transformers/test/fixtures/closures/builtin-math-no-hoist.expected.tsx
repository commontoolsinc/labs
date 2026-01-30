import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
export default pattern(({ value }) => {
    const floored = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
            }
        },
        required: ["value"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { value: value }, ({ value }) => Math.floor(value));
    return { floored };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        floored: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["floored"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
