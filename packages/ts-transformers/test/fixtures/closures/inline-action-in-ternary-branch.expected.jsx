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
/**
 * Regression test: inline arrow function inside explicit computed() in JSX
 *
 * Variation where an inline arrow function handler is wrapped inside an
 * explicit computed() in JSX. The transformer will convert the arrow function
 * to a handler, and the Cell reference (state.isEditing) must be properly
 * captured in the lift-applied computation created for the computed.
 */
import { Cell, computed, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Card {
    title: string;
    description: string;
}
interface State {
    card: Card;
    isEditing: Cell<boolean>;
}
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                isEditing: {
                    type: "boolean",
                    asCell: ["writeonly"]
                }
            },
            required: ["isEditing"]
        }
    },
    required: ["state"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { state }) => state.isEditing.set(true));
__cfBindVerifiedBinding(__cfHandler_1, {
    sourceFile: "/test.tsx",
    position: { line: 39, col: 34 }
});
const __cfLift_1 = __cfHelpers.lift<{
    state: {
        isEditing: __cfHelpers.ReadonlyCell<boolean>;
    };
}, __cfHelpers.JSXElement>(({ state }) => (<cf-button onClick={__cfHandler_1({
    state: {
        isEditing: state.isEditing
    }
})}>Edit</cf-button>), {
    type: "object",
    properties: {
        state: {
            type: "object",
            properties: {
                isEditing: {
                    type: "boolean",
                    asCell: ["readonly"]
                }
            },
            required: ["isEditing"]
        }
    },
    required: ["state"]
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
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 38, col: 22 }
});
// FIXTURE: inline-action-in-ternary-branch
// Verifies: inline arrow handler inside explicit computed() in a ternary branch is extracted and captured in a lift-applied computation
//   computed(() => <cf-button onClick={() => state.isEditing.set(true)} />) → lift(..., handler(...)(...))({ state: { isEditing: asCell } })
// Context: Regression -- inline handler inside computed() must have its Cell ref captured in the lift-applied computation
export default __cfBindVerifiedBinding(pattern((state) => {
    return {
        [UI]: (<cf-card>
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
        } as const satisfies __cfHelpers.JSONSchema, state.key("isEditing"), <div>Editing</div>, <div>
            <span>{state.key("card", "title")}</span>
            {/* Explicit computed() wrapping a button with inline handler */}
            {/* The Cell ref in the handler must be captured in the lift-applied computation */}
            {__cfLift_1({ state: {
                    isEditing: state.key("isEditing")
                } })}
          </div>)}
      </cf-card>),
        card: state.key("card"),
    };
}, {
    type: "object",
    properties: {
        card: {
            $ref: "#/$defs/Card"
        },
        isEditing: {
            type: "boolean",
            asCell: ["cell"]
        }
    },
    required: ["card", "isEditing"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        card: {
            $ref: "#/$defs/Card"
        }
    },
    required: ["$UI", "card"],
    $defs: {
        Card: {
            type: "object",
            properties: {
                title: {
                    type: "string"
                },
                description: {
                    type: "string"
                }
            },
            required: ["title", "description"]
        },
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
    position: { line: 27, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1,
    __cfLift_1
});
