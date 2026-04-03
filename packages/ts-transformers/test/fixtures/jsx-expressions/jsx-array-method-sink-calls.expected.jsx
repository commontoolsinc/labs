function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
          {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).join(", "))}
        </p>
        <p>
          Filter map joined:{" "}
          {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold"),
                factor: state.key("factor")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).map((x) => x * state.factor).join(", "))}
        </p>
        <p>
          Filter joined upper:{" "}
          {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                threshold: state.key("threshold")
            } }, ({ state }) => state.items.filter((x) => x > state.threshold).join(", ").toUpperCase())}
        </p>
        <p>
          Filter joined upper trimmed:{" "}
          {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
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
__ctHardenFn(h);
