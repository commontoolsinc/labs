import * as __ctHelpers from "commontools";
/**
 * action() results used as event handlers in JSX. action() is an
 * opaque origin but handler results are typically used directly
 * (no property access), so opaque classification doesn't affect them.
 */
import { action, pattern, UI, Writable } from "commontools";
interface State {
    label: string;
}
export default pattern((__ct_pattern_input) => {
    const label = __ct_pattern_input.key("label");
    const count = Writable.of(0, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const increment = __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
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
    })({
        count: count
    });
    const decrement = __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            count: {
                type: "number",
                asCell: true
            }
        },
        required: ["count"]
    } as const satisfies __ctHelpers.JSONSchema, (_, { count }) => {
        count.set(count.get() - 1);
    })({
        count: count
    });
    return {
        [UI]: (<div>
        <span>{label}: {count}</span>
        <ct-button onClick={increment}>+</ct-button>
        <ct-button onClick={decrement}>-</ct-button>
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
} as const satisfies __ctHelpers.JSONSchema, {
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
