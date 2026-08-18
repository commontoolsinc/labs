function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { unless, pattern, UI, NAME } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    value: string | null;
    defaultValue: string;
}
// FIXTURE: schema-injection-unless
// Verifies: unless() gets condition, fallback, and result schemas injected
//   unless(value, defaultValue) → unless(conditionSchema, fallbackSchema, resultSchema, value, defaultValue)
//   pattern<State>(fn)          → pattern(fn, inputSchema, outputSchema)
// Context: unless(cond, fallback) returns cond if truthy, else fallback; schemas reflect the union type
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const value = __cf_pattern_input.key("value");
    const defaultValue = __cf_pattern_input.key("defaultValue");
    // unless(condition, fallback) - returns condition if truthy, else fallback
    const result = unless({
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        anyOf: [{
                type: "string"
            }, {
                type: "null"
            }]
    } as const satisfies __cfHelpers.JSONSchema, value, defaultValue).for("result", true);
    return {
        [NAME]: "unless schema test",
        [UI]: <div>{result}</div>,
    };
}, {
    type: "object",
    properties: {
        value: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        },
        defaultValue: {
            type: "string"
        }
    },
    required: ["value", "defaultValue"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
