import * as __ctHelpers from "commontools";
import { Writable, computed, pattern } from "commontools";
// FIXTURE: computed-optional-chaining
// Verifies: computed() with optional chaining and nullish coalescing on captured cells
//   computed(() => value.get() * (config.get()?.multiplier ?? 1)) → derive(..., { value, config }, ({ value, config }) => ...)
//   The config cell has a nullable type (anyOf [object, null]) with asCell: true in the capture schema.
export default pattern(() => {
    const config = Writable.of<{
        multiplier?: number;
    } | null>({ multiplier: 2 }, {
        anyOf: [{
                type: "object",
                properties: {
                    multiplier: {
                        type: "number"
                    }
                }
            }, {
                type: "null"
            }]
    } as const satisfies __ctHelpers.JSONSchema);
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
                asCell: true
            }
        },
        required: ["value", "config"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        config: config
    }, ({ value, config }) => value.get() * (config.get()?.multiplier ?? 1));
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
