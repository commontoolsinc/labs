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
 * action() results used as event handlers in JSX. action() is an
 * opaque origin but handler results are typically used directly
 * (no property access), so opaque classification doesn't affect them.
 */
import { action, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    label: string;
}
// FIXTURE: action-result-not-opaque
// Verifies: action() results used as JSX event handlers are not marked asOpaque in the output
//   action(() => count.set(...)) → handler(false, { count: { asCell } }, (_, { count }) => ...)({ count })
// Context: action() is an opaque origin, but handler results are used directly (no property access)
export default pattern((__cf_pattern_input) => {
    const label = __cf_pattern_input.key("label");
    const count = Writable.of(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const increment = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            count: {
                type: "number",
                asCell: true
            }
        },
        required: ["count"]
    } as const satisfies __cfHelpers.JSONSchema, (_, { count }) => {
        count.set(count.get() + 1);
    })({
        count: count
    });
    const decrement = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            count: {
                type: "number",
                asCell: true
            }
        },
        required: ["count"]
    } as const satisfies __cfHelpers.JSONSchema, (_, { count }) => {
        count.set(count.get() - 1);
    })({
        count: count
    });
    return {
        [UI]: (<div>
        <span>{label}: {count}</span>
        <cf-button onClick={increment}>+</cf-button>
        <cf-button onClick={decrement}>-</cf-button>
      </div>),
        count,
    };
}, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["$UI", "count"],
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
