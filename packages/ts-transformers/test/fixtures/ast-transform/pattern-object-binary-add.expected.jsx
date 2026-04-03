import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
// FIXTURE: pattern-object-binary-add
// Verifies: top-level non-JSX arithmetic in an object property is lowered after
//   closure normalization into a direct derive wrapper rather than left as raw
//   arithmetic over opaque values.
//   return { next: state.count + 1 }
//   → return { next: derive(state.count + 1) }
export default pattern((state) => ({
    next: __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    count: {
                        type: "number"
                    }
                },
                required: ["count"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            count: state.key("count")
        } }, ({ state }) => state.count + 1),
}), {
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
        next: {
            type: "number"
        }
    },
    required: ["next"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
