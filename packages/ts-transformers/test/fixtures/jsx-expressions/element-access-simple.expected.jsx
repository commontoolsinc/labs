import * as __cfHelpers from "commonfabric";
import { pattern, UI } from "commonfabric";
interface State {
    items: string[];
    index: number;
    matrix: number[][];
    row: number;
    col: number;
}
// FIXTURE: element-access-simple
// Verifies: dynamic element access on reactive arrays is wrapped in derive()
//   state.items[state.index]            → derive({items, index}, ({state}) => state.items[state.index])
//   state.items[state.items.length - 1] → derive({items}, ...)
//   state.matrix[state.row]![state.col] → derive({matrix, row, col}, ...)
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Dynamic Element Access</h3>
        {/* Basic dynamic index */}
        <p>Item: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                index: state.key("index")
            } }, ({ state }) => state.items[state.index])}</p>

        {/* Computed index */}
        <p>Last: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items")
            } }, ({ state }) => state.items[state.items.length - 1])}</p>

        {/* Double indexing */}
        <p>Matrix: {__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
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
