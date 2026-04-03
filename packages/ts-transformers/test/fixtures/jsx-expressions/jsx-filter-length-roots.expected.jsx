import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
// FIXTURE: jsx-filter-length-roots
// Verifies: structural filter-length wrappers use the shared post-closure path
//   instead of rewriting the filter callback itself to filterWithPattern().
//   items.filter(fn).length
//   items.filter(fn).length > 0
//   items.filter(fn).length > 0 ? "Yes" : "No"
// Context: all three shapes should lower without leaking callback locals.
export default pattern((state) => ({
    [UI]: (<div>
      <p>{__ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    },
                    threshold: {
                        type: "number"
                    }
                },
                required: ["items", "threshold"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items"),
            threshold: state.key("threshold")
        } }, ({ state }) => state.items.filter((x) => x > state.threshold).length)}</p>
      <p>{__ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    },
                    threshold: {
                        type: "number"
                    }
                },
                required: ["items", "threshold"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items"),
            threshold: state.key("threshold")
        } }, ({ state }) => state.items.filter((x) => x > state.threshold).length > 0)}</p>
      <p>
        {__ctHelpers.ifElse({
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema, {
        "enum": ["Yes", "No"]
    } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    },
                    threshold: {
                        type: "number"
                    }
                },
                required: ["items", "threshold"]
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items"),
            threshold: state.key("threshold")
        } }, ({ state }) => state.items.filter((x) => x > state.threshold).length > 0), "Yes", "No")}
      </p>
    </div>),
}), {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "number"
            }
        },
        threshold: {
            type: "number"
        }
    },
    required: ["items", "threshold"]
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
