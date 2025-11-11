import * as __ctHelpers from "commontools";
import { cell, computed } from "commontools";
export default function TestComputeOptionalChaining() {
    const config = cell<{
        multiplier?: number;
    } | null>({ multiplier: 2 });
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
                asOpaque: true
            }
        },
        required: ["value", "config"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value: value,
        config: config
    }, ({ value, config }) => value.get() * (config.get()?.multiplier ?? 1));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
