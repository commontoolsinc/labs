function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ element: row, params: {} }) => ({
    value: __cfHelpers.derive({
        type: "object",
        properties: {
            row: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        },
        required: ["row"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, { row: {
            done: row.done
        } }, ({ row }) => identity(row.done ? "Done" : "Pending")),
    list: [__cfHelpers.derive({
            type: "object",
            properties: {
                row: {
                    type: "object",
                    properties: {
                        done: {
                            type: "boolean"
                        }
                    },
                    required: ["done"]
                }
            },
            required: ["row"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { row: {
                done: row.done
            } }, ({ row }) => identity(row.done ? "Done" : "Pending"))],
}));
const __cfModuleCallback_2 = __cfHardenFn(({ element: row, params: {} }) => __cfHelpers.derive({
    type: "object",
    properties: {
        row: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    },
    required: ["row"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { row: {
        done: row.done
    } }, ({ row }) => identity(row.done ? "Done" : "Pending")));
const identity = __cfHardenFn((value: string) => value);
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
// FIXTURE: computed-map-call-root-containers
// Verifies: inside a computed-array .map() callback, callback-local ordinary
//   call roots whole-wrap as callback-local derives across object-property,
//   array-element, and direct return-expression sites.
//   ({ value: identity(row.done ? "Done" : "Pending") })
//   → ({ value: derive(..., ({ row }) => identity(row.done ? "Done" : "Pending")) })
//   [identity(row.done ? "Done" : "Pending")]
//   → [derive(..., ({ row }) => identity(row.done ? "Done" : "Pending"))]
//   row => identity(row.done ? "Done" : "Pending")
//   → row => derive(..., ({ row }) => identity(row.done ? "Done" : "Pending"))
export default pattern((state) => {
    const rows = __cfHelpers.derive({
        type: "object",
        properties: {
            state: {
                type: "object",
                properties: {
                    items: {
                        type: "array",
                        items: {
                            $ref: "#/$defs/Item"
                        }
                    }
                },
                required: ["items"]
            }
        },
        required: ["state"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            $ref: "#/$defs/Item"
        },
        $defs: {
            Item: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        }
    } as const satisfies __cfHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => state.items).for("rows", true);
    const views = rows.mapWithPattern(__cfHelpers.pattern(__cfModuleCallback_1, {
        type: "object",
        properties: {
            element: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        },
        required: ["element"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "object",
        properties: {
            value: {
                type: "string"
            },
            list: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: ["value", "list"]
    } as const satisfies __cfHelpers.JSONSchema), {}).for("views", true);
    const labels = rows.mapWithPattern(__cfHelpers.pattern(__cfModuleCallback_2, {
        type: "object",
        properties: {
            element: {
                type: "object",
                properties: {
                    done: {
                        type: "boolean"
                    }
                },
                required: ["done"]
            }
        },
        required: ["element"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema), {}).for("labels", true);
    return { views, labels };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                done: {
                    type: "boolean"
                }
            },
            required: ["done"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        views: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    value: {
                        type: "string"
                    },
                    list: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["value", "list"]
            }
        },
        labels: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["views", "labels"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
