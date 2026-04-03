import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
// FIXTURE: boolean-result-schema-normalization
// Verifies: boolean result schemas stay normalized as `type: "boolean"` instead
// of expanding into literal `true` / `false` enums.
export default pattern((state: {
    isPremium: boolean;
    score: number;
}) => {
    return {
        [UI]: <div>{__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            "enum": ["Premium", "Regular"]
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.unless({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, state.key("isPremium"), __ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        score: {
                            type: "number"
                        }
                    },
                    required: ["score"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                score: state.key("score")
            } }, ({ state }) => state.score > 100)), "Premium", "Regular")}</div>,
    };
}, {
    type: "object",
    properties: {
        isPremium: {
            type: "boolean"
        },
        score: {
            type: "number"
        }
    },
    required: ["isPremium", "score"]
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
