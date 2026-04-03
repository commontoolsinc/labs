import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
interface Config {
    required: number;
    unionUndefined: number | undefined;
}
// FIXTURE: derive-union-undefined
// Verifies: captured properties with `number | undefined` union types produce correct schemas
//   derive(value, fn) → derive(schema, schema, { value, config: { required, unionUndefined } }, fn)
// Context: `unionUndefined` schema is `type: ["number", "undefined"]`; `required` is plain `number`
export default pattern((config: Config) => {
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
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, {
        value,
        config: {
            required: config.key("required"),
            unionUndefined: config.key("unionUndefined")
        }
    }, ({ value: v, config }) => v.get() + config.required + (config.unionUndefined ?? 0));
    return result;
}, {
    type: "object",
    properties: {
        required: {
            type: "number"
        },
        unionUndefined: {
            type: ["number", "undefined"]
        }
    },
    required: ["required", "unionUndefined"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
