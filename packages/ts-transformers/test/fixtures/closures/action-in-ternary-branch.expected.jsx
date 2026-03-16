import * as __ctHelpers from "commontools";
/**
 * Regression test: action() result used in same ternary branch as computed()
 *
 * When a ternary branch contains both a computed() value and an action() reference,
 * the nested computed expression should still lower locally in JSX without forcing
 * the whole JSX branch through an extra derive wrapper.
 */
import { action, Cell, computed, pattern, UI } from "commontools";
interface Card {
    title: string;
    description: string;
}
interface Input {
    card: Card;
}
// FIXTURE: action-in-ternary-branch
// Verifies: action() result used in a ternary branch alongside computed() keeps
//   local JSX rewrites instead of forcing a whole-branch derive
//   action(() => ...) → handler(eventSchema, captureSchema, (_, { isEditing }) => ...)({ isEditing })
//   nested hasDescription ternary → local ifElse(...) inside the JSX branch
// Context: Regression coverage for JSX-local rewriting with action references in the same branch
export default pattern((__ct_pattern_input) => {
    const card = __ct_pattern_input.key("card");
    const isEditing = Cell.of(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    const startEditing = __ctHelpers.handler(false as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            isEditing: {
                type: "boolean",
                asCell: true
            }
        },
        required: ["isEditing"]
    } as const satisfies __ctHelpers.JSONSchema, (_, { isEditing }) => {
        isEditing.set(true);
    })({
        isEditing: isEditing
    });
    const hasDescription = __ctHelpers.derive({
        type: "object",
        properties: {
            card: {
                type: "object",
                properties: {
                    description: {
                        type: "string"
                    }
                },
                required: ["description"]
            }
        },
        required: ["card"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { card: {
            description: card.key("description")
        } }, ({ card }) => {
        const desc = card.description;
        return desc && desc.length > 0;
    });
    return {
        [UI]: (<ct-card>
        {__ctHelpers.ifElse({
            type: "boolean",
            asCell: true
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, isEditing, <div>Editing</div>, <div>
            <span>{card.key("title")}</span>
            {/* Nested ternary with computed - lowers locally inside JSX */}
            {__ctHelpers.ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, hasDescription, <span>{card.key("description")}</span>, null)}
            {/* Action in SAME branch stays direct while JSX-local rewrites handle the computed value */}
            <ct-button onClick={startEditing}>Edit</ct-button>
          </div>)}
      </ct-card>),
        card,
    };
}, {
    type: "object",
    properties: {
        card: {
            $ref: "#/$defs/Card"
        }
    },
    required: ["card"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        card: {
            $ref: "#/$defs/Card"
        }
    },
    required: ["$UI", "card"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        },
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
