import * as __ctHelpers from "commontools";
import { computed, pattern, } from "commontools";
interface Input {
    foo: string;
}
interface Output extends Input {
    bar: number;
}
// FIXTURE: pattern-explicit-types
// Verifies: explicit Input and Output type parameters generate separate input/output schemas
//   pattern<Input, Output>() → input schema from Input, output schema from Output (includes inherited fields)
//   Output extends Input → output schema includes both own (bar) and inherited (foo) properties
export default pattern((input) => {
    return __ctHelpers.derive({
        type: "object",
        properties: {
            input: {
                type: "object",
                properties: {
                    foo: {
                        type: "string"
                    }
                },
                required: ["foo"],
                asOpaque: true
            }
        },
        required: ["input"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            bar: {
                type: "number"
            },
            foo: {
                type: "string",
                asOpaque: true
            }
        },
        required: ["bar", "foo"]
    } as const satisfies __ctHelpers.JSONSchema, { input: input }, ({ input: input_1 }) => ({ ...input, bar: 123 }));
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        bar: {
            type: "number"
        },
        foo: {
            type: "string"
        }
    },
    required: ["bar", "foo"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
