import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
type SelectedScopes = {
    gmail: boolean;
    calendar: boolean;
};
const SCOPE_DESCRIPTIONS = {
    gmail: "Gmail",
    calendar: "Calendar",
} as const;
interface Input {
    selectedScopes: SelectedScopes;
}
// FIXTURE: map-plain-array-dynamic-checkbox
// Verifies: plain-array callback roots stay plain while dynamic JSX bindings still derive
//   Object.entries(...).map(fn)                     -> plain .map() remains plain
//   selectedScopes[key as keyof SelectedScopes]     -> derived binding with selectedScopes and key captures
// Context: Dynamic property access in a plain array callback used as a ct-checkbox binding
export default pattern((__ct_pattern_input) => {
    const selectedScopes = __ct_pattern_input.key("selectedScopes");
    return {
        [UI]: (<div>
        {Object.entries(SCOPE_DESCRIPTIONS).map(([key, description]) => (<label>
            <ct-checkbox $checked={__ctHelpers.derive({
                type: "object",
                properties: {
                    selectedScopes: {
                        $ref: "#/$defs/SelectedScopes"
                    },
                    key: {
                        type: "string"
                    }
                },
                required: ["selectedScopes", "key"],
                $defs: {
                    SelectedScopes: {
                        type: "object",
                        properties: {
                            gmail: {
                                type: "boolean"
                            },
                            calendar: {
                                type: "boolean"
                            }
                        },
                        required: ["gmail", "calendar"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, {
                selectedScopes: selectedScopes,
                key: key
            }, ({ selectedScopes, key }) => selectedScopes[key as keyof SelectedScopes])}>
              {description}
            </ct-checkbox>
          </label>))}
      </div>),
    };
}, {
    type: "object",
    properties: {
        selectedScopes: {
            $ref: "#/$defs/SelectedScopes"
        }
    },
    required: ["selectedScopes"],
    $defs: {
        SelectedScopes: {
            type: "object",
            properties: {
                gmail: {
                    type: "boolean"
                },
                calendar: {
                    type: "boolean"
                }
            },
            required: ["gmail", "calendar"]
        }
    }
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
