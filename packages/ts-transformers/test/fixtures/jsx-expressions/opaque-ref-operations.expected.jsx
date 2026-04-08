function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: opaque-ref-operations
// Verifies: arithmetic on cell-backed OpaqueRefs in JSX is wrapped in derive() with asCell schema
//   {count}           → {count}  (bare ref, no transform)
//   {count.get() + 1} → derive({count: asCell}, ({count}) => count.get() + 1)
//   {price.get() * 1.1} → derive({price: asCell}, ...)
export default pattern((_state) => {
    const count = cell(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const price = cell(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return {
        [UI]: (<div>
        <p>Count: {count}</p>
        <p>Next: {__cfHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { count: count }, ({ count }) => count.get() + 1)}</p>
        <p>Double: {__cfHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["count"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { count: count }, ({ count }) => count.get() * 2)}</p>
        <p>Total: {__cfHelpers.derive({
            type: "object",
            properties: {
                price: {
                    type: "number",
                    asCell: true
                }
            },
            required: ["price"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { price: price }, ({ price }) => price.get() * 1.1)}</p>
      </div>),
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
