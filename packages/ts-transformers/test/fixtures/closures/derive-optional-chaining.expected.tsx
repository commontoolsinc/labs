import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
interface Config {
    multiplier?: number;
}
export default function TestDerive(config: Config) {
    const value = cell(10);
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
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
                }
            }
        },
        required: ["value", "config"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        config: {
            multiplier: config.multiplier
        }
    }, ({ value: v, config }) => v * (config.multiplier ?? 1));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
