function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Cell, cell, handler, ifElse, lift, NAME, navigateTo, pattern, UI, } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// the simple charm (to which we'll store references within a cell)
const SimplePattern = pattern(() => ({
    [NAME]: "Some Simple Pattern",
    [UI]: <div>Some Simple Pattern</div>,
}), false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$NAME", "$UI"],
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
// Create a cell to store an array of charms
const createCellRef = lift(({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
        console.log("Creating cellRef - first time");
        const newCellRef = Cell.for<any[]>("charmsArray").asSchema({
            type: "array",
            items: true
        } as const satisfies __cfHelpers.JSONSchema);
        newCellRef.set([]);
        // Local cast: the schema types storedCellRef as a cell of a generic object,
        // but this fixture stores an array cell into it; the schema accuracy isn't
        // what this transformer fixture exercises.
        (storedCellRef as Cell<unknown>).set(newCellRef);
        isInitialized.set(true);
        return {
            cellRef: newCellRef,
        };
    }
    else {
        console.log("cellRef already initialized");
    }
    // If already initialized, return the stored cellRef
    return {
        cellRef: storedCellRef,
    };
}, {
    type: "object",
    properties: {
        isInitialized: { type: "boolean", "default": false, asCell: ["cell"] },
        storedCellRef: { type: "object", asCell: ["cell"] },
    },
    required: ["isInitialized", "storedCellRef"],
});
// Add a charm to the array and navigate to it
// we get a new isInitialized passed in for each
// charm we add to the list. this makes sure
// we only try to add the charm once to the list
// and we only call navigateTo once
const addCharmAndNavigate = lift(({ charm, cellRef, isInitialized }) => {
    if (!isInitialized.get()) {
        if (cellRef) {
            cellRef.push(charm);
            isInitialized.set(true);
            return navigateTo(charm);
        }
        else {
            console.log("addCharmAndNavigate undefined cellRef");
        }
    }
    return undefined;
}, {
    type: "object",
    properties: {
        charm: { type: "object" },
        cellRef: { type: "array", asCell: ["cell"] },
        isInitialized: { type: "boolean", asCell: ["cell"] },
    },
    required: ["charm", "isInitialized"],
});
// Create a new SimplePattern and add it to the array
const createSimplePattern = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        cellRef: {
            type: "array",
            items: true,
            asCell: ["readonly"]
        }
    },
    required: ["cellRef"]
} as const satisfies __cfHelpers.JSONSchema, (_, { cellRef }) => {
    // Create isInitialized cell for this charm addition
    const isInitialized = cell(false, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema).for("isInitialized", true);
    // Create the charm
    const charm = SimplePattern({});
    // Store the charm in the array and navigate
    return addCharmAndNavigate({ charm, cellRef, isInitialized });
});
// Handler to navigate to a specific charm from the list
const goToCharm = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        charm: {
            type: "unknown",
            asCell: ["opaque"]
        }
    },
    required: ["charm"]
} as const satisfies __cfHelpers.JSONSchema, (_, { charm }) => {
    console.log("goToCharm clicked");
    return navigateTo(charm);
});
const __cfLift_1 = __cfHelpers.lift<{
    cellRef: unknown[];
}, boolean>(({ cellRef }) => !cellRef?.length, {
    type: "object",
    properties: {
        cellRef: {
            type: "array",
            items: {
                type: "unknown"
            }
        }
    },
    required: ["cellRef"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.exprLift("expr:+", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 + __cfExpr1);
const __cfLift_3 = __cfHelpers.exprLift("expr:+", {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, ([__cfExpr0, __cfExpr1]) => __cfExpr0 + __cfExpr1);
const __cfLift_4 = __cfHelpers.lift<{
    charm: any;
}, any>(({ charm }) => charm[__cfHelpers.NAME], {
    type: "object",
    properties: {
        charm: true
    },
    required: ["charm"]
} as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema);
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const charm = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return (<li>
                <cf-button onClick={goToCharm({ charm })}>
                  Go to Charm {__cfLift_2([index, 1])}
                </cf-button>
                <span>Charm {__cfLift_3([index, 1])}: {__cfHelpers.unless(true as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, __cfLift_4({ charm: charm }), "Unnamed")}</span>
              </li>);
}, {
    type: "object",
    properties: {
        element: true,
        index: {
            type: "number"
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
// FIXTURE: opaque-ref-cell-map
// Verifies: a reactive factory result still rewrites JSX ifElse predicates after
//           the forbidden OpaqueRef cast is removed
//   ifElse(!cellRef?.length, <div>, <ul>) → ifElse(schema..., lift(...)(...), <div>, <ul>)
//   cellRef.map((charm, index) => <li>...) → mapWithPattern(...) even with
//     `as { cellRef: any[] }`, because the cast does not change the reactive origin
// Context: Real-world pattern using Cell.for<any[]>(), handler, lift, and navigateTo
// create the named cell inside the pattern body, so we do it just once
export default pattern(() => {
    // cell to store array of charms we created
    const __cf_destructure_1 = createCellRef({
        isInitialized: cell(false, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema),
        storedCellRef: cell(),
    }) as {
        cellRef: any[];
    }, cellRef = __cf_destructure_1.key("cellRef").for("cellRef", true);
    return {
        [NAME]: "Charms Launcher",
        [UI]: (<div>
        <h3>Stored Charms:</h3>
        {ifElse({
            type: "boolean"
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
        } as const satisfies __cfHelpers.JSONSchema, {} as const satisfies __cfHelpers.JSONSchema, __cfLift_1({ cellRef: cellRef }), <div>No charms created yet</div>, <ul>
            {cellRef.mapWithPattern(__cfPattern_1, {})}
          </ul>)}

        <cf-button onClick={createSimplePattern({ cellRef })}>
          Create New Charm
        </cf-button>
      </div>),
        cellRef,
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string",
            "enum": ["Charms Launcher"]
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        cellRef: {
            type: "array",
            items: true
        }
    },
    required: ["$NAME", "$UI", "cellRef"],
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
__cfReg({
    SimplePattern,
    createCellRef,
    addCharmAndNavigate,
    createSimplePattern,
    goToCharm,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4,
    __cfPattern_1
});
