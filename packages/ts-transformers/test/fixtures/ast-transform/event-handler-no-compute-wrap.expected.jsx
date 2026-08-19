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
import { Cell, Default, handler, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "cf-button": any;
        }
    }
}
const handleClick = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, (_, { count }) => {
    count.set(count.get() + 1);
});
__cfBindVerifiedBinding(handleClick, {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 2 },
    bindingName: "handleClick"
});
const __cfLift_1 = __cfHelpers.lift<{
    count: Default<number, 0>;
}, number>(({ count }) => count + 1, {
    type: "object",
    properties: {
        count: {
            type: "number",
            "default": 0
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 34, col: 24 }
});
// FIXTURE: event-handler-no-compute-wrap
// Verifies: handler invocations in JSX are NOT wrapped in a reactive compute
// wrapper (formerly derive, now lift-applied post-CT-1615), while
// expressions are.
//   count + 1 (in JSX <span>)                → __cfHelpers.lift<...>(({ count }) => count + 1)({ count })
//   handleClick({ count }) (onClick attr)    → left as-is (not wrapped)
//   handleClick({ count }) (inside .map())   → left as-is (not wrapped)
//   pattern<{ count: Default<number, 0> }>   → pattern(fn, inputSchema, outputSchema)
// Context: Negative test ensuring handler calls in event attributes and
// inside .map() are not wrapped as reactive compute.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const count = __cf_pattern_input.key("count");
    return {
        [UI]: (<div>
          {/* Regular JSX expression - should be wrapped in a lift-applied computation */}
          <span>Count: {__cfLift_1({ count: count })}</span>

          {/* Event handler with Reactive - should NOT be wrapped in a lift-applied computation */}
          <cf-button onClick={handleClick({ count })}>
            Click me
          </cf-button>

          {/* Event handler inside map - should NOT be wrapped in a lift-applied computation */}
          {[1, 2, 3].map((n) => (<cf-button key={n} onClick={handleClick({ count })}>
              Button {n}
            </cf-button>))}
        </div>),
        count,
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number",
            "default": 0
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        count: {
            type: "number"
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 29, col: 2 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    handleClick,
    __cfLift_1
});
