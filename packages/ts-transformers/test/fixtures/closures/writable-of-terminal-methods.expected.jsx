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
/**
 * new Writable() result accessed via .get()/.set() in action
 * callbacks. These are terminal methods handled correctly regardless
 * of opaque classification — new Writable() is an opaque origin and
 * .get()/.set() are terminal methods.
 */
import { action, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    title: string;
}
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        counter: {
            type: "number",
            asCell: ["writeonly"]
        },
        label: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["counter", "label"]
} as const satisfies __cfHelpers.JSONSchema, (_, { counter, label }) => {
    counter.set(0);
    label.set("Count");
});
__cfBindVerifiedBinding(__cfHandler_1, {
    sourceFile: "/test.tsx",
    position: { line: 27, col: 23 },
    bindingName: "reset"
});
// FIXTURE: writable-of-terminal-methods
// Verifies: new Writable() gets schema annotation, and action() with .set() becomes handler()
//   new Writable(0) → new Writable(0, { type: "number" })
//   action(() => { counter.set(0); label.set("Count"); }) → handler(false, captureSchema, (_, { counter, label }) => ...)
//   ({ title }) → (__cf_pattern_input) => { title = __cf_pattern_input.key("title"); }
// Context: new Writable() produces opaque cells. The .set() calls inside
//   action() are terminal methods that require the action to be rewritten as a
//   handler with captured cell references (counter, label) in its schema.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    const counter = new Writable(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("counter", true);
    const label = new Writable("Count", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema).for("label", true);
    const reset = __cfHandler_1({
        counter: counter,
        label: label
    }).for({ stream: "reset" }, true);
    return {
        [UI]: (<div>
        <span>{title} {label}: {counter}</span>
        <cf-button onClick={reset}>Reset</cf-button>
      </div>),
        counter: counter.for(["__patternResult", "counter"], true),
        label: label.for(["__patternResult", "label"], true)
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string"
        }
    },
    required: ["title"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        counter: {
            type: "number",
            asCell: ["cell"]
        },
        label: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["$UI", "counter", "label"],
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
    position: { line: 23, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1
});
