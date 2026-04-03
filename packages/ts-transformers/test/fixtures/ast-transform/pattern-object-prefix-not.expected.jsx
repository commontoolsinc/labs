import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
// FIXTURE: pattern-object-prefix-not
// Verifies: top-level non-JSX unary boolean negation in an object property is
//   lowered after closure normalization into a direct derive wrapper.
//   return { hidden: !state.done }
//   → return { hidden: derive(!state.done) }
export default pattern((state) => ({
    hidden: __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            done: state.key("done")
        } }, ({ state }) => !state.done),
}), {
    type: "object",
    properties: {
        done: {
            type: "boolean"
        }
    },
    required: ["done"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        hidden: {
            type: "boolean"
        }
    },
    required: ["hidden"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
