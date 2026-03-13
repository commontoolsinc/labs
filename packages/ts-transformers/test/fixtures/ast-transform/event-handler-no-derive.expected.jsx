import * as __ctHelpers from "commontools";
import { Cell, Default, handler, pattern, UI } from "commontools";
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "ct-button": any;
        }
    }
}
const handleClick = handler({
    type: "unknown"
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema, (_, { count }) => {
    count.set(count.get() + 1);
});
// FIXTURE: event-handler-no-derive
// Verifies: handler invocations in JSX are NOT wrapped in derive(), while expressions are
//   count + 1 (in JSX <span>)                → __ctHelpers.derive(...schemas, { count }, ({ count }) => count + 1)
//   handleClick({ count }) (onClick attr)     → left as-is (not wrapped in derive)
//   handleClick({ count }) (inside .map())    → left as-is (not wrapped in derive)
//   pattern<{ count: Default<number, 0> }>    → pattern(fn, inputSchema, outputSchema)
// Context: Negative test ensuring handler calls in event attributes and inside .map() are not derive-wrapped
export default pattern((__ct_pattern_input) => {
    const count = __ct_pattern_input.key("count");
    return {
        [UI]: (<div>
          {/* Regular JSX expression - should be wrapped in derive */}
          <span>Count: {__ctHelpers.derive({
            type: "object",
            properties: {
                count: {
                    type: "number",
                    asOpaque: true
                }
            },
            required: ["count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema, { count: count }, ({ count }) => count + 1)}</span>

          {/* Event handler with OpaqueRef - should NOT be wrapped in derive */}
          <ct-button onClick={handleClick({ count })}>
            Click me
          </ct-button>

          {/* Event handler inside map - should NOT be wrapped in derive */}
          {[1, 2, 3].map((n) => (<ct-button key={n} onClick={handleClick({ count })}>
              Button {n}
            </ct-button>))}
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        count: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["$UI", "count"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
