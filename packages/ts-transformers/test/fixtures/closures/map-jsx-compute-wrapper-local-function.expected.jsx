import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
export default pattern((__ct_pattern_input) => {
    const list = __ct_pattern_input.key("list");
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
            type: "object",
            properties: {
                list: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["list"]
        } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { list: list }, ({ list }) => [0, 1].forEach(() => {
            const project = (value: string) => value.toUpperCase();
            return list.map((item) => project(item));
        }))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        list: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["list"]
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
