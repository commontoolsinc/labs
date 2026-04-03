import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
const double = (x: number) => x * 2;
// FIXTURE: pattern-local-helper-call-roots
// Verifies: top-level ordinary local helper calls with reactive inputs are
//   lifted as whole calls, while plain inputs stay plain.
//   double(2)                 -> unchanged plain JS call
//   double(state.count + 1)   -> derive(..., ({ state }) => double(state.count + 1))
export default pattern((state) => ({
    staticDoubled: double(2),
    doubled: __ctHelpers.derive({
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
        } }, ({ state }) => double(state.count + 1)),
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
        staticDoubled: {
            type: "number"
        },
        doubled: {
            type: "number"
        }
    },
    required: ["staticDoubled", "doubled"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
