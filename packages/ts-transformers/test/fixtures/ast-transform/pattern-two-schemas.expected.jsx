import * as __ctHelpers from "commontools";
import { pattern, type JSONSchema } from "commontools";
import "commontools/schema";
// Test that pattern with both schemas already present is not transformed
export default pattern({
    type: "object",
    properties: {
        count: { type: "number" }
    },
    required: ["count"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        doubled: { type: "number" }
    },
    required: ["doubled"]
} as const satisfies JSONSchema, ({ count }) => {
    return {
        doubled: count * 2
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
