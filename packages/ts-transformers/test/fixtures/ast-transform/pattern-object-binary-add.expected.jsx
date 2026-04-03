import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
// FIXTURE: pattern-object-binary-add
// Verifies: top-level non-JSX arithmetic in an object property is lowered after
//   closure normalization into a direct derive wrapper rather than left as raw
//   arithmetic over opaque values.
//   return { next: state.count + 1 }
//   → return { next: derive(state.count + 1) }
export default pattern((state) => ({
    next: __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, { state: {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        next: {
            type: "number"
        }
    },
    required: ["next"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
