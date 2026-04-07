function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { ifElse, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface State {
    matrix: number[][];
    row: number;
    col: number;
    items: string[];
    arr: number[];
    a: number;
    b: number;
    indices: number[];
    nested: {
        arrays: string[][];
        index: number;
    };
    users: Array<{
        name: string;
        scores: number[];
    }>;
    selectedUser: number;
    selectedScore: number;
}
// FIXTURE: element-access-complex
// Verifies: complex element-access patterns (nested, computed, chained, conditional) are wrapped in derive()
//   state.matrix[state.row]![state.col]         → derive({matrix, row, col}, ...)
//   state.arr[state.a + state.b]                → derive({arr, a, b}, ...)
//   state.users[state.selectedUser]!.scores[..] → derive({users, selectedUser, selectedScore}, ...)
// Context: Covers nested indexing, computed indices, chained access, conditions, operators
export default pattern((state) => {
    return {
        [UI]: (<div>
        <h3>Nested Element Access</h3>
        {/* Double indexing into matrix */}
        <p>Matrix value: {__cfHelpers.derive({
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

        {/* Triple nested access */}
        <p>Deep nested: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        nested: {
                            type: "object",
                            properties: {
                                arrays: {
                                    type: "array",
                                    items: {
                                        type: "array",
                                        items: {
                                            type: "string"
                                        }
                                    }
                                },
                                index: {
                                    type: "number"
                                }
                            },
                            required: ["arrays", "index"]
                        },
                        row: {
                            type: "number"
                        }
                    },
                    required: ["nested", "row"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                nested: {
                    arrays: state.key("nested", "arrays"),
                    index: state.key("nested", "index")
                },
                row: state.key("row")
            } }, ({ state }) => state.nested.arrays[state.nested.index]![state.row])}</p>

        <h3>Multiple References to Same Array</h3>
        {/* Same array accessed multiple times with different indices */}
        <p>
          First and last: {state.key("items", "0")} and{" "}
          {__cfHelpers.derive({
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
            } }, ({ state }) => state.items[state.items.length - 1])}
        </p>

        {/* Array used in computation and access */}
        <p>Sum of ends: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["arr"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                arr: state.key("arr")
            } }, ({ state }) => state.arr[0]! + state.arr[state.arr.length - 1]!)}</p>

        <h3>Computed Indices</h3>
        {/* Index from multiple state values */}
        <p>Computed index: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        a: {
                            type: "number"
                        },
                        b: {
                            type: "number"
                        }
                    },
                    required: ["arr", "a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                arr: state.key("arr"),
                a: state.key("a"),
                b: state.key("b")
            } }, ({ state }) => state.arr[state.a + state.b])}</p>

        {/* Index from computation involving array */}
        <p>Modulo index: {__cfHelpers.derive({
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
                        row: {
                            type: "number"
                        }
                    },
                    required: ["items", "row"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                row: state.key("row")
            } }, ({ state }) => state.items[state.row % state.items.length])}</p>

        {/* Complex index expression */}
        <p>Complex: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        a: {
                            type: "number"
                        }
                    },
                    required: ["arr", "a"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                arr: state.key("arr"),
                a: state.key("a")
            } }, ({ state }) => state.arr[Math.min(state.a * 2, state.arr.length - 1)])}</p>

        <h3>Chained Element Access</h3>
        {/* Element access returning array, then accessing that */}
        <p>
          User score:{" "}
          {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    },
                                    scores: {
                                        type: "array",
                                        items: {
                                            type: "number"
                                        }
                                    }
                                },
                                required: ["name", "scores"]
                            }
                        },
                        selectedUser: {
                            type: "number"
                        },
                        selectedScore: {
                            type: "number"
                        }
                    },
                    required: ["users", "selectedUser", "selectedScore"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                users: state.key("users"),
                selectedUser: state.key("selectedUser"),
                selectedScore: state.key("selectedScore")
            } }, ({ state }) => state.users[state.selectedUser]!.scores[state.selectedScore])!}
        </p>

        {/* Using one array element as index for another */}
        <p>Indirect: {__cfHelpers.derive({
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
                        indices: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["items", "indices"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["string", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                indices: state.key("indices")
            } }, ({ state }) => state.items[state.indices[0]!])}</p>

        {/* Array element used as index for same array */}
        <p>Self reference: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["arr"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: ["number", "undefined"]
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                arr: state.key("arr")
            } }, ({ state }) => state.arr[state.arr[0]!])}</p>

        <h3>Mixed Property and Element Access</h3>
        {/* Property access followed by element access with computed index */}
        <p>Mixed: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        nested: {
                            type: "object",
                            properties: {
                                arrays: {
                                    type: "array",
                                    items: {
                                        type: "array",
                                        items: {
                                            type: "string"
                                        }
                                    }
                                },
                                index: {
                                    type: "number"
                                }
                            },
                            required: ["arrays", "index"]
                        }
                    },
                    required: ["nested"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                nested: {
                    arrays: state.key("nested", "arrays"),
                    index: state.key("nested", "index")
                }
            } }, ({ state }) => state.nested.arrays[state.nested.index]!.length)}</p>

        {/* Element access followed by property access */}
        <p>User name length: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        users: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    name: {
                                        type: "string"
                                    },
                                    scores: {
                                        type: "array",
                                        items: {
                                            type: "number"
                                        }
                                    }
                                },
                                required: ["name", "scores"]
                            }
                        },
                        selectedUser: {
                            type: "number"
                        }
                    },
                    required: ["users", "selectedUser"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                users: state.key("users"),
                selectedUser: state.key("selectedUser")
            } }, ({ state }) => state.users[state.selectedUser]!.name.length)}</p>

        <h3>Element Access in Conditions</h3>
        {/* Element access in ternary */}
        <p>
          Conditional:{" "}
          {__cfHelpers.ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        a: {
                            type: "number"
                        }
                    },
                    required: ["arr", "a"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                arr: state.key("arr"),
                a: state.key("a")
            } }, ({ state }) => state.arr[state.a]! > 10), __cfHelpers.derive({
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
                        b: {
                            type: "number"
                        }
                    },
                    required: ["items", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                b: state.key("b")
            } }, ({ state }) => state.items[state.b]!), state.key("items", "0")!)}
        </p>

        {/* Element access in boolean expression */}
        <p>
          Has value: {ifElse({
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
            "enum": ["positive", "non-positive"]
        } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
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
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                matrix: state.key("matrix"),
                row: state.key("row"),
                col: state.key("col")
            } }, ({ state }) => state.matrix[state.row]![state.col]! > 0), "positive", "non-positive")}
        </p>

        <h3>Element Access with Operators</h3>
        {/* Element access with arithmetic */}
        <p>Product: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        },
                        a: {
                            type: "number"
                        },
                        b: {
                            type: "number"
                        }
                    },
                    required: ["arr", "a", "b"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                arr: state.key("arr"),
                a: state.key("a"),
                b: state.key("b")
            } }, ({ state }) => state.arr[state.a]! * state.arr[state.b]!)}</p>

        {/* Element access with string concatenation */}
        <p>Concat: {__cfHelpers.derive({
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
                        indices: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["items", "indices"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                items: state.key("items"),
                indices: state.key("indices")
            } }, ({ state }) => state.items[0]! + " - " + state.items[state.indices[0]!]!)}</p>

        {/* Multiple element accesses in single expression */}
        <p>Sum: {__cfHelpers.derive({
            type: "object",
            properties: {
                state: {
                    type: "object",
                    properties: {
                        arr: {
                            type: "array",
                            items: {
                                type: "number"
                            }
                        }
                    },
                    required: ["arr"]
                }
            },
            required: ["state"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema, { state: {
                arr: state.key("arr")
            } }, ({ state }) => state.arr[0]! + state.arr[1]! + state.arr[2]!)}</p>
      </div>),
    };
}, {
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
        },
        items: {
            type: "array",
            items: {
                type: "string"
            }
        },
        arr: {
            type: "array",
            items: {
                type: "number"
            }
        },
        a: {
            type: "number"
        },
        b: {
            type: "number"
        },
        indices: {
            type: "array",
            items: {
                type: "number"
            }
        },
        nested: {
            type: "object",
            properties: {
                arrays: {
                    type: "array",
                    items: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                index: {
                    type: "number"
                }
            },
            required: ["arrays", "index"]
        },
        users: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    scores: {
                        type: "array",
                        items: {
                            type: "number"
                        }
                    }
                },
                required: ["name", "scores"]
            }
        },
        selectedUser: {
            type: "number"
        },
        selectedScore: {
            type: "number"
        }
    },
    required: ["matrix", "row", "col", "items", "arr", "a", "b", "indices", "nested", "users", "selectedUser", "selectedScore"]
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
__cfHardenFn(h);
