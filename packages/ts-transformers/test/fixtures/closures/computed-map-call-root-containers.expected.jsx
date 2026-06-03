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
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, Item[]>({
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
} as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.items);
const __cfLift_2 = __cfHelpers.lift<{
    row: {
        done: boolean;
    };
}, string>({
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
} as const satisfies __cfHelpers.JSONSchema, ({ row }) => identity(row.done ? "Done" : "Pending"));
const __cfLift_3 = __cfHelpers.lift<{
    row: {
        done: boolean;
    };
}, string>({
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
} as const satisfies __cfHelpers.JSONSchema, ({ row }) => identity(row.done ? "Done" : "Pending"));
const __cfLift_4 = __cfHelpers.lift<{
    row: {
        done: boolean;
    };
}, string>({
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
} as const satisfies __cfHelpers.JSONSchema, ({ row }) => identity(row.done ? "Done" : "Pending"));
const identity = __cfHardenFn((value: string) => value);
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
// FIXTURE: computed-map-call-root-containers
// Verifies: inside a computed-array .map() callback, callback-local ordinary
//   call roots whole-wrap as callback-local lift-applied computations across
//   object-property, array-element, and direct return-expression sites.
//   ({ value: identity(row.done ? "Done" : "Pending") })
//   → ({ value: lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...) })
//   [identity(row.done ? "Done" : "Pending")]
//   → [lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...)]
//   row => identity(row.done ? "Done" : "Pending")
//   → row => lift(({ row }) => identity(row.done ? "Done" : "Pending"))(...)
export default pattern((state) => {
    const rows = __cfLift_1({ state: {
            items: state.key("items")
        } }).for("rows", true);
    const views = rows.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
        const row = __cf_pattern_input.key("element");
        return ({
            value: __cfLift_2({ row: {
                    done: row.key("done")
                } }),
            list: [__cfLift_3({ row: {
                        done: row.key("done")
                    } })],
        });
    }, {
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/Item"
            }
        },
        required: ["element"],
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
    const labels = rows.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
        const row = __cf_pattern_input.key("element");
        return __cfLift_4({ row: {
                done: row.key("done")
            } });
    }, {
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/Item"
            }
        },
        required: ["element"],
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
