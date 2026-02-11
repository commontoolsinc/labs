import * as __ctHelpers from "commontools";
import { Cell, derive, recipe, UI } from "commontools";
interface Item {
    name: string;
    done: Cell<boolean>;
}
interface Assignment {
    aisle: string;
    item: Item;
}
// CT-1036: Property access on derived grouped objects with derived keys
// This pattern groups items by a property, then maps over the group keys
// and accesses the grouped object with each key.
export default recipe({
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
                done: {
                    type: "boolean",
                    asCell: true
                }
            },
            required: ["name", "done"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, ({ items }) => {
    // Create assignments with aisle data
    const itemsWithAisles = derive({
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    $ref: "#/$defs/Item"
                },
                asOpaque: true
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
                    done: {
                        type: "boolean",
                        asCell: true
                    }
                },
                required: ["name", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "object",
            properties: {
                aisle: {
                    type: "string"
                },
                item: {
                    $ref: "#/$defs/Item",
                    asOpaque: true
                }
            },
            required: ["aisle", "item"]
        },
        asOpaque: true,
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean",
                        asCell: true
                    }
                },
                required: ["name", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { items }, ({ items }) => items.map((item, idx) => ({
        aisle: `Aisle ${(idx % 3) + 1}`,
        item: item,
    })));
    // Group by aisle - returns Record<string, Assignment[]>
    const groupedByAisle = derive({
        type: "object",
        properties: {
            itemsWithAisles: {
                type: "array",
                items: {
                    type: "object",
                    properties: {
                        aisle: {
                            type: "string"
                        },
                        item: {
                            $ref: "#/$defs/Item",
                            asOpaque: true
                        }
                    },
                    required: ["aisle", "item"]
                },
                asOpaque: true
            }
        },
        required: ["itemsWithAisles"],
        $defs: {
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean",
                        asCell: true
                    }
                },
                required: ["name", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {},
        additionalProperties: {
            type: "array",
            items: {
                $ref: "#/$defs/Assignment"
            }
        },
        $defs: {
            Assignment: {
                type: "object",
                properties: {
                    aisle: {
                        type: "string"
                    },
                    item: {
                        $ref: "#/$defs/Item"
                    }
                },
                required: ["aisle", "item"]
            },
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean",
                        asCell: true
                    }
                },
                required: ["name", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, { itemsWithAisles }, ({ itemsWithAisles }) => {
        const groups: Record<string, Assignment[]> = {};
        for (const assignment of itemsWithAisles) {
            if (!groups[assignment.aisle]) {
                groups[assignment.aisle] = [];
            }
            groups[assignment.aisle]!.push(assignment);
        }
        return groups;
    });
    // Derive sorted aisle names from grouped object
    const aisleNames = derive({
        type: "object",
        properties: {
            groupedByAisle: {
                type: "object",
                properties: {},
                additionalProperties: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Assignment"
                    }
                },
                asOpaque: true
            }
        },
        required: ["groupedByAisle"],
        $defs: {
            Assignment: {
                type: "object",
                properties: {
                    aisle: {
                        type: "string"
                    },
                    item: {
                        $ref: "#/$defs/Item"
                    }
                },
                required: ["aisle", "item"]
            },
            Item: {
                type: "object",
                properties: {
                    name: {
                        type: "string"
                    },
                    done: {
                        type: "boolean",
                        asCell: true
                    }
                },
                required: ["name", "done"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { groupedByAisle }, ({ groupedByAisle }) => Object.keys(groupedByAisle).sort());
    // The pattern from CT-1036:
    // - Map over derived keys (aisleNames)
    // - Access derived object with derived key (groupedByAisle[aisleName])
    // - Map over the result
    return {
        [UI]: (<div>
          {aisleNames.mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    },
                    params: {
                        type: "object",
                        properties: {
                            groupedByAisle: {
                                type: "object",
                                properties: {},
                                additionalProperties: {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/Assignment"
                                    }
                                },
                                asOpaque: true
                            }
                        },
                        required: ["groupedByAisle"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Assignment: {
                        type: "object",
                        properties: {
                            aisle: {
                                type: "string"
                            },
                            item: {
                                $ref: "#/$defs/Item"
                            }
                        },
                        required: ["aisle", "item"]
                    },
                    Item: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            done: {
                                type: "boolean",
                                asCell: true
                            }
                        },
                        required: ["name", "done"]
                    }
                }
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: aisleName, params: { groupedByAisle } }) => (<div>
              <h3>{aisleName}</h3>
              {(__ctHelpers.derive({
                type: "object",
                properties: {
                    groupedByAisle: {
                        type: "object",
                        properties: {},
                        additionalProperties: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Assignment"
                            }
                        },
                        asOpaque: true
                    },
                    aisleName: {
                        type: "string",
                        asOpaque: true
                    }
                },
                required: ["groupedByAisle", "aisleName"],
                $defs: {
                    Assignment: {
                        type: "object",
                        properties: {
                            aisle: {
                                type: "string"
                            },
                            item: {
                                $ref: "#/$defs/Item"
                            }
                        },
                        required: ["aisle", "item"]
                    },
                    Item: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            done: {
                                type: "boolean",
                                asCell: true
                            }
                        },
                        required: ["name", "done"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: {
                    $ref: "#/$defs/Assignment"
                },
                asOpaque: true,
                $defs: {
                    Assignment: {
                        type: "object",
                        properties: {
                            aisle: {
                                type: "string"
                            },
                            item: {
                                $ref: "#/$defs/Item"
                            }
                        },
                        required: ["aisle", "item"]
                    },
                    Item: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            done: {
                                type: "boolean",
                                asCell: true
                            }
                        },
                        required: ["name", "done"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                groupedByAisle: groupedByAisle,
                aisleName: aisleName
            }, ({ groupedByAisle, aisleName }) => groupedByAisle[aisleName]! ?? [])).mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Assignment"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Assignment: {
                        type: "object",
                        properties: {
                            aisle: {
                                type: "string"
                            },
                            item: {
                                $ref: "#/$defs/Item"
                            }
                        },
                        required: ["aisle", "item"]
                    },
                    Item: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            },
                            done: {
                                type: "boolean",
                                asCell: true
                            }
                        },
                        required: ["name", "done"]
                    }
                }
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: assignment, params: {} }) => (<div>
                  <span>{assignment.item.name}</span>
                  <ct-checkbox $checked={assignment.item.done}/>
                </div>)), {})}
            </div>)), {
                groupedByAisle: groupedByAisle
            })}
        </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
