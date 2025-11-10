import * as __ctHelpers from "commontools";
import { cell, derive } from "commontools";
interface Config {
    required: number;
    unionUndefined: number | undefined;
}
export default function TestDerive(config: Config) {
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
                    required: {
                        type: "number"
                    },
                    unionUndefined: {
                        type: "number"
                    }
                },
                required: ["required"]
            }
        },
        required: ["value", "config"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        config: {
            required: config.required,
            unionUndefined: config.unionUndefined
        }
    }, ({ value: v, config }) => v + config.required + (config.unionUndefined ?? 0));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
