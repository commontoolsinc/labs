import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
type State = {
    user: {
        settings: {
            notifications: boolean;
        };
    };
};
// FIXTURE: pattern-boolean-ifelse-predicate-schema
// Verifies: ternaries lowered from `.key(...)` reads keep a boolean predicate
// schema instead of collapsing to `true`.
export default pattern((state) => ({
    [UI]: (<div>
      {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["enabled", "disabled"]
    } as const satisfies __cfHelpers.JSONSchema, state.key("user", "settings", "notifications"), "enabled", "disabled")}
    </div>),
}), {
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                settings: {
                    type: "object",
                    properties: {
                        notifications: {
                            type: "boolean"
                        }
                    },
                    required: ["notifications"]
                }
            },
            required: ["settings"]
        }
    },
    required: ["user"]
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
