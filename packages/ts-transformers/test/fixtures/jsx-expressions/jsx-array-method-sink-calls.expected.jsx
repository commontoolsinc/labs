import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    items: number[];
    threshold: number;
    factor: number;
}
// FIXTURE: jsx-array-method-sink-calls
// Verifies: direct JSX sink receiver-methods over structural array-method chains can use the shared post-closure path
//   state.items.filter(fn).join(", ")                        → shared post-closure derive over the sink call
//   state.items.filter(fn).map(fn).join(", ")                → shared post-closure derive over the sink call
//   state.items.filter(fn).join(", ").toUpperCase()          → shared post-closure derive over the chained call
//   state.items.filter(fn).join(", ").toUpperCase().trim()   → shared post-closure derive over the recursive chained call
// Context: Verifies recursive receiver-method chaining above a shareable array-method sink base
export default pattern((state) => {
    return {
        [UI]: (<div>
        <p>
          Filter joined:{" "}
          {__ctHelpers.derive({
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
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).join(", "))}
        </p>
        <p>
          Filter map joined:{" "}
          {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        factor: {
                            type: "number"
                        },
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
                    required: ["factor", "items", "threshold"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold"),
                factor: state.key("factor")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).map((x) => x * state.factor).join(", "))}
        </p>
        <p>
          Filter joined upper:{" "}
          {__ctHelpers.derive({
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
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).join(", ").toUpperCase())}
        </p>
        <p>
          Filter joined upper trimmed:{" "}
          {__ctHelpers.derive({
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
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).join(", ").toUpperCase()
            .trim())}
        </p>
      </div>),
    };
}, {
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
        },
        factor: {
            type: "number"
        }
    },
    required: ["items", "threshold", "factor"]
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
