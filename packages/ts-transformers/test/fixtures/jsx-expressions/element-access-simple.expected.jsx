import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    items: string[];
    index: number;
    matrix: number[][];
    row: number;
    col: number;
}
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        },
                        index: {
                            type: "number"
                        }
                    },
                    required: ["items", "index"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string"
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items"),
                index: state.key("index")
            } }, ({ state }) => state.items[state.index])}</p>

        {/* Computed index */}
        <p>Last: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        items: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["items"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "string"
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items[state.items.length - 1])}</p>

        {/* Double indexing */}
        <p>Matrix: {__ctHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        matrix: {
                            type: "array",
                            items: {
                                type: "array",
                                items: {
                                    type: "number"
                                }
                            }
                        },
                        row: {
                            type: "number"
                        },
                        col: {
                            type: "number"
                        }
                    },
                    required: ["matrix", "row", "col"]
                }
            },
            required: ["state"]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{
                    type: "undefined"
                }, {
                    type: "number"
                }]
        } as const satisfies __ctHelpers.JSONSchema, { state: {
                matrix: state.key("matrix"),
                row: state.key("row"),
                col: state.key("col")
            } }, ({ state }) => state.matrix[state.row]![state.col])}</p>
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        index: {
            type: "number"
        },
        matrix: {
            type: "array",
            items: {
                type: "array",
                items: {
                    type: "number"
                }
            }
        },
        row: {
            type: "number"
        },
        col: {
            type: "number"
        }
    },
    required: ["items", "index", "matrix", "row", "col"]
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
