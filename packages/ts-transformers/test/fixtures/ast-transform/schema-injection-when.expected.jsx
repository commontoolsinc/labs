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
import { when, pattern, UI, NAME } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    enabled: boolean;
    message: string;
}
// FIXTURE: schema-injection-when
// Verifies: when() gets condition, value, and result schemas injected
//   when(enabled, message) → when(conditionSchema, valueSchema, resultSchema, enabled, message)
//   pattern<State>(fn)     → pattern(fn, inputSchema, outputSchema)
// Context: when(cond, value) returns value if cond is truthy, else cond; result schema is union type
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const enabled = __cf_pattern_input.key("enabled");
    const message = __cf_pattern_input.key("message");
    // when(condition, value) - returns value if condition is truthy, else condition
    const result = when({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: ["boolean", "string"]
    } as const satisfies __cfHelpers.JSONSchema, enabled, message).for("result", true);
    return {
        [NAME]: "when schema test",
        [UI]: <div>{result}</div>,
    };
}, {
    type: "object",
    properties: {
        enabled: {
            type: "boolean"
        },
        message: {
            type: "string"
        }
    },
    required: ["enabled", "message"]
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
