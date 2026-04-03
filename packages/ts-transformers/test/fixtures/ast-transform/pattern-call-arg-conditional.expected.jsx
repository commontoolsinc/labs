import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
const identity = <T,>(value: T) => value;
// FIXTURE: pattern-call-arg-conditional
// Verifies: top-level ordinary helper calls with reactive arguments are lifted
//   as whole calls rather than lowering only the inner argument expression.
//   const label = identity(state.done ? "Done" : "Pending")
//   → const label = derive(..., ({ state }) => identity(state.done ? "Done" : "Pending"))
export default pattern((state) => {
    const label = __ctHelpers.derive({
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
        "enum": ["Done", "Pending"]
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            done: state.key("done")
        } }, ({ state }) => identity(state.done ? "Done" : "Pending"));
    return { label };
}, {
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
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
