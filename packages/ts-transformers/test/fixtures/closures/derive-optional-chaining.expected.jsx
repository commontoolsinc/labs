import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
interface Config {
    multiplier?: number;
}
export default function TestDerive(config: Config) {
    const value = cell(10, {
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
                        type: ["number", "undefined"]
                    }
                }
            }
        },
        required: ["value", "config"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        config: {
            multiplier: config.multiplier
        }
    }, ({ value: v, config }) => v.get() * (config.multiplier ?? 1));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
