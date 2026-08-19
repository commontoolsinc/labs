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
import { cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    count: __cfHelpers.Cell<number>;
}, number>(({ count }) => count.get() + 1, {
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 17, col: 18 }
});
const __cfLift_2 = __cfHelpers.lift<{
    count: __cfHelpers.Cell<number>;
}, number>(({ count }) => count.get() * 2, {
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 20 }
});
const __cfLift_3 = __cfHelpers.lift<{
    price: __cfHelpers.Cell<number>;
}, number>(({ price }) => price.get() * 1.1, {
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_3, {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 19 }
});
// FIXTURE: reactive-operations
// Verifies: arithmetic on cell-backed Reactives in JSX is wrapped in a lift-applied computation with asCell schema
//   {count}           → {count}  (bare ref, no transform)
//   {count.get() + 1} → lift(({count}) => count.get() + 1)({ count: asCell })
//   {price.get() * 1.1} → lift(...)({ price: asCell })
export default __cfBindVerifiedBinding(pattern((_state) => {
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 9, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3
});
