import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    title: string;
    count: number;
}
export default pattern((__ct_pattern_input) => {
    const title = __ct_pattern_input.key("title");
    const count = __ct_pattern_input.key("count");
    return {
        [UI]: <div>{title}:{count}</div>,
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string",
            "default": "Untitled"
        },
        count: {
            type: "number",
            "default": 0
        }
    },
    required: ["title", "count"]
} as const satisfies __ctHelpers.JSONSchema, {
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable"
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
