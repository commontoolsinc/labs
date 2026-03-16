import * as __ctHelpers from "commontools";
import { computed, pattern, type JSONSchema } from "commontools";
import "commontools/schema";
// Test that pattern with both schemas already present is not transformed
interface Input {
    count: number;
}
interface Result {
    doubled: number;
}
// FIXTURE: pattern-two-schemas
// Verifies: pattern with both input and output schemas already present preserves them
//   pattern<Input, Result>(fn, inputSchema, outputSchema) → pattern(fn, inputSchema, outputSchema) (schemas kept)
//   ({ count }) destructuring                              → __ct_pattern_input.key("count")
// Context: Schemas are user-provided, not generated; type args are stripped but schemas remain
export default pattern((__ct_pattern_input) => {
    const count = __ct_pattern_input.key("count");
    return {
        doubled: __ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count * 2)
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        doubled: {
            type: "number"
        }
    },
    required: ["doubled"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
