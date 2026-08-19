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
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    title: string;
    count: number;
}
// FIXTURE: pattern-static-default-destructure
// Verifies: destructured pattern params with default values become schema defaults, not runtime defaults
//   ({ title = "Untitled", count = 0 }) → (__cf_pattern_input) => { title = __cf_pattern_input.key("title"); ... }
//   default values → schema: { title: { type: "string", default: "Untitled" }, count: { type: "number", default: 0 } }
// Context: Static default values in the destructuring pattern are lifted into
//   the JSON schema as "default" annotations rather than kept as JS defaults.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    const count = __cf_pattern_input.key("count");
    return {
        [UI]: <div>{title}:{count}</div>,
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string",
            "default": "Untitled"
        },
        count: {
            type: "number",
            "default": 0
        }
    },
    required: ["title", "count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
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
    position: { line: 15, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
