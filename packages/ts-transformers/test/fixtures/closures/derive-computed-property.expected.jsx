import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
export default function TestDerive() {
    const value = cell(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const config = { multiplier: 2, divisor: 5 };
    const key = "multiplier";
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
                    },
                    divisor: {
                        type: "number"
                    }
                },
                required: ["multiplier", "divisor"]
            },
            key: {
                type: "string"
            }
        },
        required: ["value", "config", "key"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        config: config,
        key: key
    }, ({ value: v, config, key }) => v.get() * config[key]);
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
