import * as __ctHelpers from "commontools";
import { Cell, Default, handler, pattern, UI } from "commontools";
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "ct-button": any;
        }
    }
}
const handleClick = handler(true as const satisfies __ctHelpers.JSONSchema, {
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
export default pattern(({ count }) => {
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
