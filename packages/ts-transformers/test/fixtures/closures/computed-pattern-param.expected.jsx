import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
// FIXTURE: computed-pattern-param
// Verifies: computed() inside a pattern captures the pattern parameter as a structured object
//   computed(() => value.get() * config.multiplier) → derive(..., { value, config: { multiplier: config.key("multiplier") } }, ({ value, config }) => ...)
// Context: The pattern parameter `config` is not destructured, so properties
//   accessed on it (config.multiplier) are rewritten to config.key("multiplier")
//   in the captures object.
export default pattern((config: {
    multiplier: number;
}) => {
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
        required: ["value", "config"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        config: {
            multiplier: config.key("multiplier")
        }
    }, ({ value, config }) => value.get() * config.multiplier);
    return result;
}, {
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asOpaque: true
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
