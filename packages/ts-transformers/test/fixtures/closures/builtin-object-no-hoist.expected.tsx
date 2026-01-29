import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
export default pattern(({ data }) => {
    const keys = __ctHelpers.derive({
        type: "object",
        properties: {
            data: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "number"
                },
                asOpaque: true
            }
        },
        required: ["data"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { data: data }, ({ data }) => Object.keys(data));
    return { keys };
}, {
    type: "object",
    properties: {
        data: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number"
            }
        }
    },
    required: ["data"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        keys: {
            type: "array",
            items: {
                type: "string"
            },
            asOpaque: true
        }
    },
    required: ["keys"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
