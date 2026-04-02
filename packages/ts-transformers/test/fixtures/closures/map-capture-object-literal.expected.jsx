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
    items: Array<{
        name: string;
    }>;
}
// FIXTURE: map-capture-object-literal
// Verifies: plain object literal closed over in .map() is captured as a non-reactive param
//   .map(fn) → .mapWithPattern(pattern(...), { style: style })
//   style (object literal) → params.style accessed via .params (not .key) since it is non-reactive
export default pattern((state) => {
    const style = { color: "red", fontSize: 14 };
    return {
        [UI]: (<div>
        {state.key("items").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const style = __ct_pattern_input.params.style;
                return (<span style={style}>{item.key("name")}</span>);
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    },
                    params: {
                        type: "object",
                        properties: {
                            style: {
                                type: "object",
                                properties: {
                                    color: {
                                        type: "string"
                                    },
                                    fontSize: {
                                        type: "number"
                                    }
                                },
                                required: ["color", "fontSize"]
                            }
                        },
                        required: ["style"]
                    }
                },
                required: ["element", "params"]
            } as const satisfies __cfHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        $ref: "#/$defs/UIRenderable"
                    }, {
                        type: "object",
                        properties: {}
                    }],
                $defs: {
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
            } as const satisfies __cfHelpers.JSONSchema), {
                style: style
            })}
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    }
                },
                required: ["name"]
            }
        }
    },
    required: ["items"]
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
