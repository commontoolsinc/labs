import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
// FIXTURE: map-jsx-compute-wrapper-local-function
// Verifies: .map() inside a non-reactive forEach is NOT transformed to mapWithPattern
//   forEach(() => list.map(...)) → derive() wrapping the entire forEach expression
// Context: Local function and reactive list inside forEach; whole block becomes a derive, not mapWithPattern
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
