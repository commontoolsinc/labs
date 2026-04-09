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
 * Writable.of() result accessed via .get()/.set() in action
 * callbacks. These are terminal methods handled correctly regardless
 * of opaque classification — Writable.of() is an opaque origin and
 * .get()/.set() are terminal methods.
 */
import { action, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    title: string;
}
// FIXTURE: writable-of-terminal-methods
// Verifies: Writable.of() gets schema annotation, and action() with .set() becomes handler()
//   Writable.of(0) → Writable.of(0, { type: "number" })
//   action(() => { counter.set(0); label.set("Count"); }) → handler(false, captureSchema, (_, { counter, label }) => ...)
//   ({ title }) → (__cf_pattern_input) => { title = __cf_pattern_input.key("title"); }
// Context: Writable.of() produces opaque cells. The .set() calls inside
//   action() are terminal methods that require the action to be rewritten as a
//   handler with captured cell references (counter, label) in its schema.
export default pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    const counter = Writable.of(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const label = Writable.of("Count", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const reset = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            counter: {
                type: "number",
                asCell: ["cell"]
            },
            label: {
                type: "string",
                asCell: ["cell"]
            }
        },
        required: ["counter", "label"]
    } as const satisfies __cfHelpers.JSONSchema, (_, { counter, label }) => {
        counter.set(0);
        label.set("Count");
    })({
        counter: counter,
        label: label
    });
    return {
        [UI]: (<div>
        <span>{title} {label}: {counter}</span>
        <cf-button onClick={reset}>Reset</cf-button>
      </div>),
        counter,
        label,
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
