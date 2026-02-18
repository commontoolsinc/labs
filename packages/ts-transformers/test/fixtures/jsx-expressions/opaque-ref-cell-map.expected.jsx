import * as __ctHelpers from "commontools";
import { Cell, cell, handler, ifElse, lift, NAME, navigateTo, OpaqueRef, pattern, UI, } from "commontools";
// the simple charm (to which we'll store references within a cell)
const SimplePattern = pattern(() => ({
    [NAME]: "Some Simple Pattern",
    [UI]: <div>Some Simple Pattern</div>,
}), false as const satisfies __ctHelpers.JSONSchema, {
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema);
// Create a cell to store an array of charms
const createCellRef = lift({
    type: "object",
    properties: {
        isInitialized: { type: "boolean", "default": false, asCell: true },
        storedCellRef: { type: "object", asCell: true },
    },
}, undefined, ({ isInitialized, storedCellRef }) => {
    if (!isInitialized.get()) {
        console.log("Creating cellRef - first time");
        const newCellRef = Cell.for<any[]>("charmsArray").asSchema({
            type: "array",
            items: true
        } as const satisfies __ctHelpers.JSONSchema);
        newCellRef.set([]);
        storedCellRef.set(newCellRef);
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
});
// Add a charm to the array and navigate to it
// we get a new isInitialized passed in for each
// charm we add to the list. this makes sure
// we only try to add the charm once to the list
// and we only call navigateTo once
const addCharmAndNavigate = lift({
    type: "object",
    properties: {
        charm: { type: "object" },
        cellRef: { type: "array", asCell: true },
        isInitialized: { type: "boolean", asCell: true },
    },
}, undefined, ({ charm, cellRef, isInitialized }) => {
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
});
// Create a new SimplePattern and add it to the array
const createSimplePattern = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        cellRef: {
            type: "array",
            items: true,
            asCell: true
        }
    },
    required: ["cellRef"]
} as const satisfies __ctHelpers.JSONSchema, (_, { cellRef }) => {
    // Create isInitialized cell for this charm addition
    const isInitialized = cell(false, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    // Create the charm
    const charm = SimplePattern({});
    // Store the charm in the array and navigate
    return addCharmAndNavigate({ charm, cellRef, isInitialized });
});
// Handler to navigate to a specific charm from the list
const goToCharm = handler(true as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        charm: true
    },
    required: ["charm"]
} as const satisfies __ctHelpers.JSONSchema, (_, { charm }) => {
    console.log("goToCharm clicked");
    return navigateTo(charm);
});
// create the named cell inside the pattern body, so we do it just once
export default pattern(() => {
    // cell to store array of charms we created
    const { cellRef } = createCellRef({
        isInitialized: cell(false, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema),
        storedCellRef: cell(),
    });
    // Type assertion to help TypeScript understand cellRef is an OpaqueRef<any[]>
    // Without this, TypeScript infers `any` and the closure transformer won't detect it
    const typedCellRef = cellRef as OpaqueRef<any[]>;
    return {
        [NAME]: "Charms Launcher",
        [UI]: (<div>
        <h3>Stored Charms:</h3>
        {ifElse({
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            anyOf: [{}, {
                    type: "object",
                    properties: {}
                }]
        } as const satisfies __ctHelpers.JSONSchema, {
            $ref: "#/$defs/UIRenderable",
            asOpaque: true,
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
        } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
            type: "object",
            properties: {
                typedCellRef: {
                    type: "array",
                    items: true,
                    asOpaque: true
                }
            },
            required: ["typedCellRef"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema, { typedCellRef: typedCellRef }, ({ typedCellRef }) => !typedCellRef?.length), <div>No charms created yet</div>, <ul>
            {typedCellRef.mapWithPattern(__ctHelpers.pattern(({ element: charm, index, params: {} }) => (<li>
                <ct-button onClick={goToCharm({ charm })}>
                  Go to Charm {__ctHelpers.derive({
                type: "object",
                properties: {
                    index: {
                        type: "number"
                    }
                },
                required: ["index"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, { index: index }, ({ index }) => index + 1)}
                </ct-button>
                <span>Charm {__ctHelpers.derive({
                type: "object",
                properties: {
                    index: {
                        type: "number"
                    }
                },
                required: ["index"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, { index: index }, ({ index }) => index + 1)}: {__ctHelpers.derive({
                type: "object",
                properties: {
                    charm: true
                },
                required: ["charm"]
            } as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, { charm: charm }, ({ charm }) => charm[NAME] || "Unnamed")}</span>
              </li>), {
                type: "object",
                properties: {
                    element: true,
                    index: {
                        type: "number"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }, {
                        type: "object",
                        properties: {}
                    }, {
                        $ref: "#/$defs/UIRenderable",
                        asOpaque: true
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
          </ul>)}

        <ct-button onClick={createSimplePattern({ cellRef })}>
          Create New Charm
        </ct-button>
      </div>),
        cellRef,
    };
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "#/$defs/JSXElement"
        },
        cellRef: true
    },
    required: ["$NAME", "$UI", "cellRef"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
