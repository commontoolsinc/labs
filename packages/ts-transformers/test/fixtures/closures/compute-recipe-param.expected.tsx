import * as __ctHelpers from "commontools";
import { cell, compute, recipe } from "commontools";
export default recipe({
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
} as const satisfies __ctHelpers.JSONSchema, (config: {
    multiplier: number;
}) => {
    const value = cell(10);
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            value: {
                type: "number",
                asOpaque: true
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
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        config: {
            multiplier: config.multiplier
        }
    }, ({ value, config }) => value.get() * config.multiplier);
    return result;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
