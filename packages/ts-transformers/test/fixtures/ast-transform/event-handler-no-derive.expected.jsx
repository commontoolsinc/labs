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
// FIXTURE: event-handler-no-derive
// Verifies: handler invocations in JSX are NOT wrapped in derive(), while expressions are
//   count + 1 (in JSX <span>)                → __cfHelpers.derive(...schemas, { count }, ({ count }) => count + 1)
//   handleClick({ count }) (onClick attr)     → left as-is (not wrapped in derive)
//   handleClick({ count }) (inside .map())    → left as-is (not wrapped in derive)
//   pattern<{ count: Default<number, 0> }>    → pattern(fn, inputSchema, outputSchema)
// Context: Negative test ensuring handler calls in event attributes and inside .map() are not derive-wrapped
export default pattern((__cf_pattern_input) => {
    const count = __cf_pattern_input.key("count");
    return {
        [UI]: (<div>
          {/* Regular JSX expression - should be wrapped in derive */}
          <span>Count: {__cfHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { count: count }, ({ count }) => count + 1)}</span>

          {/* Event handler with OpaqueRef - should NOT be wrapped in derive */}
          <cf-button onClick={handleClick({ count })}>
            Click me
          </cf-button>

          {/* Event handler inside map - should NOT be wrapped in derive */}
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
