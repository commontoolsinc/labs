function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * Regression test: action() result used in same ternary branch as computed()
 *
 * When a ternary branch contains both a computed() value and an action() reference,
 * the nested computed expression should still lower locally in JSX without forcing
 * the whole JSX branch through an extra derive wrapper.
 */
import { action, Cell, computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
export default pattern((__cf_pattern_input) => {
    const card = __cf_pattern_input.key("card");
    const isEditing = Cell.of(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    const startEditing = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            isEditing: {
                type: "boolean",
                asCell: true
            }
        },
        required: ["isEditing"]
    } as const satisfies __cfHelpers.JSONSchema, (_, { isEditing }) => {
        isEditing.set(true);
    })({
        isEditing: isEditing
    });
    const hasDescription = __cfHelpers.derive({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": [false, true, ""]
    } as const satisfies __cfHelpers.JSONSchema, { card: {
            description: card.key("description")
        } }, ({ card }) => {
        const desc = card.description;
        return desc && desc.length > 0;
    });
    return {
        [UI]: (<cf-card>
        {__cfHelpers.ifElse({
            type: "boolean",
            asCell: true
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, isEditing, <div>Editing</div>, <div>
            <span>{card.key("title")}</span>
            {/* Nested ternary with computed - lowers locally inside JSX */}
            {__cfHelpers.ifElse({
            "enum": [false, true, ""]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, hasDescription, <span>{card.key("description")}</span>, null)}
            {/* Action in SAME branch stays direct while JSX-local rewrites handle the computed value */}
            <cf-button onClick={startEditing}>Edit</cf-button>
          </div>)}
      </cf-card>),
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
} as const satisfies __cfHelpers.JSONSchema, {
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
