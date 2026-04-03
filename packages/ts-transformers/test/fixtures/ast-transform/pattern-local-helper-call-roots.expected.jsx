import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
const double = (x: number) => x * 2;
// FIXTURE: pattern-local-helper-call-roots
// Verifies: top-level ordinary local helper calls with reactive inputs are
//   lifted as whole calls, while plain inputs stay plain.
//   double(2)                 -> unchanged plain JS call
//   double(state.count + 1)   -> derive(..., ({ state }) => double(state.count + 1))
export default pattern((state) => ({
    staticDoubled: double(2),
    doubled: __cfHelpers.derive({
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
        } }, ({ state }) => double(state.count + 1)),
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
        staticDoubled: {
            type: "number"
        },
        doubled: {
            type: "number"
        }
    },
    required: ["staticDoubled", "doubled"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
