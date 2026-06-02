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
const __cfLift_1 = __cfHelpers.lift<{
    count: __cfHelpers.Cell<number>;
}, number>({
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, ({ count }) => count.get() + 1);
const __cfLift_2 = __cfHelpers.lift<{
    count: __cfHelpers.Cell<number>;
}, number>({
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, ({ count }) => count.get() * 2);
const __cfLift_3 = __cfHelpers.lift<{
    price: __cfHelpers.Cell<number>;
}, number>({
    type: "object",
    properties: {
        price: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["price"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, ({ price }) => price.get() * 1.1);
// FIXTURE: opaque-ref-operations
// Verifies: arithmetic on cell-backed OpaqueRefs in JSX is wrapped in derive() with asCell schema
//   {count}           → {count}  (bare ref, no transform)
//   {count.get() + 1} → derive({count: asCell}, ({count}) => count.get() + 1)
//   {price.get() * 1.1} → derive({price: asCell}, ...)
export default pattern((_state) => {
    const count = cell(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("count", true);
    const price = cell(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("price", true);
    return {
        [UI]: (<div>
        <p>Count: {count}</p>
        <p>Next: {__cfLift_1({ count: count })}</p>
        <p>Double: {__cfLift_2({ count: count })}</p>
        <p>Total: {__cfLift_3({ price: price })}</p>
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
