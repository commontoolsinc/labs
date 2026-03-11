import * as __ctHelpers from "commontools";
import { computed, pattern } from "commontools";
interface MyInput {
    value: number;
}
// FIXTURE: pattern-with-type
// Verifies: pattern with inline typed parameter generates input and output schemas
//   pattern((input: MyInput) => ...)   → pattern((input) => ..., inputSchema, outputSchema)
//   input.value                        → input.key("value")
// Context: Identical structure to pattern-with-name-and-type; confirms consistent behavior
export default pattern((input: MyInput) => {
    return {
        result: __ctHelpers.derive({
            type: "object",
            properties: {
                input: {
                    type: "object",
                    properties: {
                        value: {
                            type: "number"
                        }
                    },
                    required: ["value"]
                }
            },
            required: ["input"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { input: {
                value: input.key("value")
            } }, ({ input: input_1 }) => input.value * 2),
    };
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
        result: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["result"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
