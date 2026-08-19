function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
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
const identity = __cfHardenFn((value: string) => value);
interface Item {
    done: boolean;
}
interface State {
    items: Item[];
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, Item[]>(({ state }) => state.items, {
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 28, col: 24 },
    bindingName: "rows"
});
const __cfLift_2 = __cfHelpers.lift<{
    row: {
        done: boolean;
    };
}, string>(({ row }) => identity(row.done ? "Done" : "Pending"), {
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 31, col: 11 }
});
const __cfLift_3 = __cfHelpers.lift<{
    row: {
        done: boolean;
    };
}, string>(({ row }) => identity(row.done ? "Done" : "Pending"), {
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_3, {
    sourceFile: "/test.tsx",
    position: { line: 32, col: 11 }
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    return ({
        value: __cfLift_2({ row: {
                done: row.key("done")
            } }).for(["__patternResult", "value"], true),
        list: [__cfLift_3({ row: {
                    done: row.key("done")
                } }).for(["__patternResult", "list", 0], true)]
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 30, col: 25 },
    bindingName: "views"
});
const __cfLift_4 = __cfHelpers.lift<{
    row: {
        done: boolean;
    };
}, string>(({ row }) => identity(row.done ? "Done" : "Pending"), {
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_4, {
    sourceFile: "/test.tsx",
    position: { line: 36, col: 4 }
});
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const row = __cf_pattern_input.key("element");
    return __cfLift_4({ row: {
            done: row.key("done")
        } }).for("__patternResult", true);
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_2, {
    sourceFile: "/test.tsx",
    position: { line: 35, col: 26 },
    bindingName: "labels"
});
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
export default __cfBindVerifiedBinding(pattern((state) => {
    const rows = __cfLift_1({ state: {
            items: state.key("items")
        } }).for("rows", true);
    const views = rows.mapWithPattern(__cfPattern_1, {}).for("views", true);
    const labels = rows.mapWithPattern(__cfPattern_2, {}).for("labels", true);
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 27, col: 2 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfPattern_1,
    __cfLift_4,
    __cfPattern_2
});
