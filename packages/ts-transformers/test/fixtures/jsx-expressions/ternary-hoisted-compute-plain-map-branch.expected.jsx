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
import { computed, pattern, UI, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    name: string;
    value: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        items: Item[];
    };
}, Item[]>(({ state }) => [...state.items].sort((a, b) => a.value - b.value), {
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
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
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
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 26 },
    bindingName: "sorted"
});
const __cfLift_2 = __cfHelpers.lift<{
    state: {
        items: {
            length: number;
        };
    };
}, number>(({ state }) => state.items.length, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                items: {
                    type: "object",
                    properties: {
                        length: {
                            type: "number"
                        }
                    },
                    required: ["length"]
                }
            },
            required: ["items"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 23, col: 25 },
    bindingName: "count"
});
// FIXTURE: ternary-hoisted-compute-plain-map-branch
// Verifies: once a ternary JSX branch is wholly compute-wrapped, compute-owned
// array maps inside that branch stay plain Array.map() calls.
//   showList ? (() => { const itemCount = count + " items"; return <div>{sorted.map(...)}</div>; })() : ...
//     → ifElse(showList, lift(() => { const itemCount = ...; return <div>{sorted.map(...)}</div>; })(...), ...)
// Context: the branch contains both a local compute-only alias and a map over
//   a computed array result, so the whole branch should be handled as compute-owned.
export default __cfBindVerifiedBinding(pattern((state) => {
    const showList = new Writable(true, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("showList", true);
    const sorted = __cfLift_1({ state: {
            items: state.key("items")
        } }).for("sorted", true);
    const count = __cfLift_2({ state: {
            items: {
                length: state.key("items", "length")
            }
        } }).for("count", true);
    return {
        [UI]: (<div>
        {__cfHelpers.ifElse({
            type: "boolean",
            asCell: ["cell"]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __cfHelpers.JSONSchema, showList, (() => {
            const itemCount = count + " items";
            return (<div>
                <span>{itemCount}</span>
                {sorted.map((item: Item) => (<span>{item.name}</span>))}
              </div>);
        })(), <span>Hidden</span>)}
      </div>),
    };
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
                name: {
                    type: "string"
                },
                value: {
                    type: "number"
                }
            },
            required: ["name", "value"]
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
    position: { line: 16, col: 42 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
