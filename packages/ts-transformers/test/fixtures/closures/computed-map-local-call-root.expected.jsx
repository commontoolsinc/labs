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
const identity = __cfHardenFn((value: string) => value);
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
// FIXTURE: computed-map-local-call-root
// Verifies: callback-local ordinary call roots in a computed-array .map()
//   callback whole-wrap as callback-local derives even when introduced through
//   a local variable initializer in non-JSX output code.
//   const label = identity(row.done ? "Done" : "Pending")
//   → const label = derive(..., ({ row }) => identity(row.done ? "Done" : "Pending"))
export default pattern((state) => {
    const rows = __cfLift_1({ state: {
            items: state.key("items")
        } }).for("rows", true);
    const labels = rows.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
        const row = __cf_pattern_input.key("element");
        const label = __cfLift_2({ row: {
                done: row.key("done")
            } }).for("label", true);
        return label;
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
    return { labels };
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
        labels: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["labels"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
