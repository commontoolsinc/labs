import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
// FIXTURE: map-jsx-compute-wrapper-no-rewrite
// Verifies: .map() nested inside a non-reactive forEach is NOT rewritten to mapWithPattern
//   forEach(() => list.map(...)) → derive() wrapping the entire expression
// Context: NEGATIVE TEST for mapWithPattern -- the .map() is inside forEach, so only derive is emitted
export default pattern((__ct_pattern_input) => {
    const list = __ct_pattern_input.key("list");
    return {
        [UI]: <div>{__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { list: list }, ({ list }) => [0, 1].forEach(() => list.map((item) => item)))}</div>,
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
