import * as __ctHelpers from "commontools";
import { computed, pattern, type JSONSchema } from "commontools";
import "commontools/schema";
interface Input {
    count: number;
}
interface Result {
    doubled: number;
}
const INPUT_SCHEMA = {
    type: "object",
    properties: {
        count: { type: "number" },
    },
    required: ["count"],
} as const satisfies JSONSchema;
const RESULT_SCHEMA = {
    type: "object",
    properties: {
        doubled: { type: "number" },
    },
    required: ["doubled"],
} as const satisfies JSONSchema;
// FIXTURE: pattern-two-schema-identifiers
// Verifies: explicit schema identifiers are preserved even when type args are present
export default pattern((__ct_pattern_input) => {
    const count = __ct_pattern_input.key("count");
    return {
        doubled: __ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asOpaque: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count * 2),
    };
}, INPUT_SCHEMA, RESULT_SCHEMA);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
