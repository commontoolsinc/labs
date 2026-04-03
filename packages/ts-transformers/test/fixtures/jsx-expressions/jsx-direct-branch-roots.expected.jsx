import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
// FIXTURE: jsx-direct-branch-roots
// Verifies: direct JSX branch roots lower structurally without leaving raw
//   child expressions in place.
//   showCompleted || !task.done ? "Visible" : "" -> nested unless/ifElse path
//   primary ? "A" : secondary ? "B" : "C"        -> nested ternary lowering
//   primary ? "A" : fallbackLabel || "C"         -> nested logical branch lowering
//   label ?? "Pending"                           -> top-level JSX nullish lowering
export default pattern((state) => ({
    [UI]: (<div>
      <p>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["", "Visible"]
    } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.unless({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, state.key("showCompleted"), __cfHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    task: {
                        type: "object",
                        properties: {
                            done: {
                                type: "boolean"
                            }
                        },
                        required: ["done"]
                    }
                },
                required: ["task"]
            }
        },
        required: ["state"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            task: {
                done: state.key("task", "done")
            }
        } }, ({ state }) => !state.task.done)), "Visible", "")}</p>
      <p>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["B", "C"]
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["B", "C", "A"]
    } as const satisfies __cfHelpers.JSONSchema, state.key("primary"), "A", __cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["B", "C"]
    } as const satisfies __cfHelpers.JSONSchema, state.key("secondary"), "B", "C"))}</p>
      <p>{__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, state.key("primary"), "A", __cfHelpers.unless({
        type: ["string", "undefined"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, state.key("fallbackLabel"), "C"))}</p>
      <p>{__cfHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    label: {
                        type: ["null", "string", "undefined"]
                    }
                }
            }
        },
        required: ["state"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            label: state.key("label")
        } }, ({ state }) => state.label ?? "Pending")}</p>
    </div>),
}), {
    type: "object",
    properties: {
        showCompleted: {
            type: "boolean"
        },
        task: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        },
        primary: {
            type: "boolean"
        },
        secondary: {
            type: "boolean"
        },
        fallbackLabel: {
            type: "string"
        },
        label: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "null"
                }]
        }
    },
    required: ["showCompleted", "task", "primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
