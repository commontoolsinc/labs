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
import { Cell, computed, Default, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Person {
    name: string;
    rank: number;
}
interface PatternInput {
    people?: Cell<Default<Person[], [
    ]>>;
}
const __cfLift_1 = __cfHelpers.lift<{
    people: __cfHelpers.ReadonlyCell<Person[]>;
}, { name: string; rank: number; isFirst: boolean; }[]>(({ people }) => [...people.get()]
    .sort((a, b) => a.rank - b.rank)
    .map((p) => ({ name: p.name, rank: p.rank, isFirst: p.rank === 1 })), {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            },
            asCell: ["readonly"]
        }
    },
    required: ["people"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                }
            },
            required: ["name", "rank"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            name: {
                type: "string"
            },
            rank: {
                type: "number"
            },
            isFirst: {
                type: "boolean"
            }
        },
        required: ["name", "rank", "isFirst"]
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 24, col: 29 },
    bindingName: "adminData"
});
const __cfLift_2 = __cfHelpers.lift<{
    people: __cfHelpers.ReadonlyCell<unknown[]>;
}, number>(({ people }) => people.get().length, {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                type: "unknown"
            },
            asCell: ["readonly"]
        }
    },
    required: ["people"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 30, col: 25 },
    bindingName: "count"
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const person = __cf_pattern_input.key("element");
    return (<span>{person.key("name")}</span>);
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Person"
        }
    },
    required: ["element"],
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                }
            },
            required: ["name", "rank"]
        }
    }
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 35, col: 20 }
});
const __cfLift_3 = __cfHelpers.lift<{
    count: number;
}, string>(({ count }) => count + " people", {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_3, {
    sourceFile: "/test.tsx",
    position: { line: 41, col: 21 }
});
const __cfPattern_2 = __cfHelpers.pattern(__cf_pattern_input => {
    const entry = __cf_pattern_input.key("element");
    return (<li>
                    {__cfHelpers.ifElse({
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        "enum": ["", "\u2605 "]
    } as const satisfies __cfHelpers.JSONSchema, entry.key("isFirst"), "★ ", "")}
                    {entry.key("name")}
                  </li>);
}, {
    type: "object",
    properties: {
        element: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                },
                isFirst: {
                    type: "boolean"
                }
            },
            required: ["name", "rank", "isFirst"]
        }
    },
    required: ["element"]
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
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_2, {
    sourceFile: "/test.tsx",
    position: { line: 43, col: 31 }
});
// FIXTURE: computed-map-in-ternary-branch
// Verifies: a computed array used inside a ternary JSX branch stays pattern-lowered
//   const adminData = computed(() => [...people.get()].sort(...).map(...))
//   adminData.map((entry) => <li>...) → adminData.mapWithPattern(pattern(...), {})
//   showAdmin ? <div>...</div> : null → ifElse(showAdmin, <div>...</div>, null)
// Context: The outer `people.map(...)` is over a pattern input cell, while the
//   inner `adminData.map(...)` is over compute-owned data but still lowered in
//   pattern context when rendered from the ternary branch.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const people = __cf_pattern_input.key("people");
    const showAdmin = new Writable(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("showAdmin", true);
    const adminData = __cfLift_1({ people: people }).for("adminData", true);
    const count = __cfLift_2({ people: people }).for("count", true);
    return {
        [UI]: (<div>
        {people.mapWithPattern(__cfPattern_1, {})}
        {__cfHelpers.ifElse({
            type: "boolean",
            asCell: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "null"
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{
                    type: "null"
                }, {}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, showAdmin, <div>
              <span>{__cfLift_3({ count: count })}</span>
              <ul>
                {adminData.mapWithPattern(__cfPattern_2, {})}
              </ul>
            </div>, null)}
      </div>),
    };
}, {
    type: "object",
    properties: {
        people: {
            type: "array",
            items: {
                $ref: "#/$defs/Person"
            },
            "default": [],
            asCell: ["cell"]
        }
    },
    $defs: {
        Person: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                rank: {
                    type: "number"
                }
            },
            required: ["name", "rank"]
        }
    }
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 21, col: 37 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2,
    __cfPattern_1,
    __cfLift_3,
    __cfPattern_2
});
