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
let keyCounter = 0;
function nextKey() {
    return `value-${keyCounter++}`;
}
__cfHardenFn(nextKey);
interface State {
    items: Array<Record<string, number>>;
}
const __cfLift_1 = __cfHelpers.lift<{
    element: any;
    __cf_amount_key: any;
}, number | undefined>(({ element, __cf_amount_key }) => element[__cf_amount_key], {
    type: "object",
    properties: {
        element: true,
        __cf_amount_key: true
    },
    required: ["element", "__cf_amount_key"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: ["number", "undefined"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx"
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const element = __cf_pattern_input.key("element");
    const __cf_amount_key = nextKey();
    const amount = __cfLift_1({
        element: element,
        __cf_amount_key: __cf_amount_key
    }).for("amount", true);
    return (<span>{amount}</span>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number"
            }
        }
    },
    required: ["element"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
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
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 22, col: 25 }
});
// FIXTURE: map-computed-alias-side-effect
// Verifies: computed property key with side effects is hoisted and used via a lift-applied computation
//   { [nextKey()]: amount } → __cf_amount_key = nextKey(); lift(...)(...element[__cf_amount_key])
//   .map(fn) → .mapWithPattern(pattern(...), {})
// Context: nextKey() has side effects (keyCounter++), so the key expression is evaluated once and cached
export default __cfBindVerifiedBinding(pattern((state) => {
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfPattern_1, {})}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "number"
                }
            }
        }
    },
    required: ["items"]
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
    position: { line: 18, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfPattern_1
});
