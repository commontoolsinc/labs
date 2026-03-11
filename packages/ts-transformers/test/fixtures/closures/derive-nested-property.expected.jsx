import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
interface State {
    config: {
        multiplier: number;
    };
}
// FIXTURE: derive-nested-property
// Verifies: a nested property path on a captured object produces a nested capture structure
//   derive(value, fn) → derive(schema, schema, { value, state: { config: { multiplier: ... } } }, fn)
// Context: `state.config.multiplier` is a two-level deep property access captured as a nested object
export default pattern((state: State) => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const result = __ctHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            state: {
                type: "object",
                properties: {
                    config: {
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number"
                            }
                        },
                        required: ["multiplier"]
                    }
                },
                required: ["config"]
            }
        },
        required: ["value", "state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        state: {
            config: {
                multiplier: state.key("config").multiplier
            }
        }
    }, ({ value: v, state }) => v.get() * state.config.multiplier);
    return result;
}, {
    type: "object",
    properties: {
        config: {
            type: "object",
            properties: {
                multiplier: {
                    type: "number"
                }
            },
            required: ["multiplier"]
        }
    },
    required: ["config"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
