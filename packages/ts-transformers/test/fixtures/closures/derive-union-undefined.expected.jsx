function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
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
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
