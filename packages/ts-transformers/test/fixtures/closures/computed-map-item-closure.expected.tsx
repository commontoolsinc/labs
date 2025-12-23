import * as __ctHelpers from "commontools";
import { computed, ifElse, UI, recipe, Cell } from "commontools";
interface Item {
    id: string;
    name: string;
}
interface State {
    items: Item[];
    editingId: Cell<string>;
}
export default recipe({
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        },
        editingId: {
            type: "string",
            asCell: true
        }
    },
    required: ["items", "editingId"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                name: {
                    type: "string"
                }
            },
            required: ["id", "name"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/Element"
        }
    },
    required: ["$UI"],
    $defs: {
        Element: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        VNode: {
            type: "object",
            properties: {
                type: {
                    type: "string",
                    "enum": ["vnode"]
                },
                name: {
                    type: "string"
                },
                props: {
                    $ref: "#/$defs/Props"
                },
                children: {
                    $ref: "#/$defs/RenderNode"
                },
                $UI: {
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["type", "name", "props"]
        },
        RenderNode: {
            anyOf: [{
                    type: "string"
                }, {
                    type: "number"
                }, {
                    type: "boolean",
                    "enum": [false]
                }, {
                    type: "boolean",
                    "enum": [true]
                }, {
                    $ref: "#/$defs/VNode"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }]
        },
        Props: {
            type: "object",
            properties: {},
            additionalProperties: {
                anyOf: [{
                        type: "string"
                    }, {
                        type: "number"
                    }, {
                        type: "boolean",
                        "enum": [false]
                    }, {
                        type: "boolean",
                        "enum": [true]
                    }, {
                        type: "object",
                        additionalProperties: true
                    }, {
                        type: "array",
                        items: true
                    }, {
                        asCell: true
                    }, {
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<ul>
        {state.items.mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {
                            state: {
                                type: "object",
                                properties: {
                                    editingId: {
                                        type: "string",
                                        asCell: true
                                    }
                                },
                                required: ["editingId"]
                            }
                        },
                        required: ["state"]
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            id: {
                                type: "string"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "object",
                properties: {
                    type: {
                        type: "string",
                        "enum": ["vnode"]
                    },
                    name: {
                        type: "string"
                    },
                    props: {
                        $ref: "#/$defs/Props"
                    },
                    children: {
                        $ref: "#/$defs/RenderNode"
                    },
                    $UI: {
                        $ref: "#/$defs/VNode"
                    }
                },
                required: ["type", "name", "props"],
                $defs: {
                    VNode: {
                        type: "object",
                        properties: {
                            type: {
                                type: "string",
                                "enum": ["vnode"]
                            },
                            name: {
                                type: "string"
                            },
                            props: {
                                $ref: "#/$defs/Props"
                            },
                            children: {
                                $ref: "#/$defs/RenderNode"
                            },
                            $UI: {
                                $ref: "#/$defs/VNode"
                            }
                        },
                        required: ["type", "name", "props"]
                    },
                    RenderNode: {
                        anyOf: [{
                                type: "string"
                            }, {
                                type: "number"
                            }, {
                                type: "boolean",
                                "enum": [false]
                            }, {
                                type: "boolean",
                                "enum": [true]
                            }, {
                                $ref: "#/$defs/VNode"
                            }, {
                                type: "object",
                                properties: {}
                            }, {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/RenderNode"
                                }
                            }]
                    },
                    Props: {
                        type: "object",
                        properties: {},
                        additionalProperties: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }, {
                                    type: "boolean",
                                    "enum": [false]
                                }, {
                                    type: "boolean",
                                    "enum": [true]
                                }, {
                                    type: "object",
                                    additionalProperties: true
                                }, {
                                    type: "array",
                                    items: true
                                }, {
                                    asCell: true
                                }, {
                                    asStream: true
                                }, {
                                    type: "null"
                                }]
                        }
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<li>
            {ifElse({
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "object",
                    properties: {
                        type: {
                            type: "string"
                        },
                        name: {
                            type: "string"
                        },
                        props: {
                            $ref: "#/$defs/Props"
                        },
                        children: {
                            $ref: "#/$defs/RenderNode"
                        },
                        $UI: {
                            $ref: "#/$defs/VNode"
                        }
                    },
                    required: ["type", "name", "props"],
                    $defs: {
                        VNode: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                props: {
                                    $ref: "#/$defs/Props"
                                },
                                children: {
                                    $ref: "#/$defs/RenderNode"
                                },
                                $UI: {
                                    $ref: "#/$defs/VNode"
                                }
                            },
                            required: ["type", "name", "props"]
                        },
                        RenderNode: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }, {
                                    type: "boolean"
                                }, {
                                    $ref: "#/$defs/VNode"
                                }, {
                                    type: "object",
                                    properties: {}
                                }, {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/RenderNode"
                                    }
                                }]
                        },
                        Props: {
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                anyOf: [{
                                        type: "string"
                                    }, {
                                        type: "number"
                                    }, {
                                        type: "boolean"
                                    }, {
                                        type: "object",
                                        additionalProperties: true
                                    }, {
                                        type: "array",
                                        items: true
                                    }, {}, {
                                        type: "null"
                                    }]
                            }
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "object",
                    properties: {
                        type: {
                            type: "string"
                        },
                        name: {
                            type: "string"
                        },
                        props: {
                            $ref: "#/$defs/Props"
                        },
                        children: {
                            $ref: "#/$defs/RenderNode"
                        },
                        $UI: {
                            $ref: "#/$defs/VNode"
                        }
                    },
                    required: ["type", "name", "props"],
                    $defs: {
                        VNode: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                props: {
                                    $ref: "#/$defs/Props"
                                },
                                children: {
                                    $ref: "#/$defs/RenderNode"
                                },
                                $UI: {
                                    $ref: "#/$defs/VNode"
                                }
                            },
                            required: ["type", "name", "props"]
                        },
                        RenderNode: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }, {
                                    type: "boolean"
                                }, {
                                    $ref: "#/$defs/VNode"
                                }, {
                                    type: "object",
                                    properties: {}
                                }, {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/RenderNode"
                                    }
                                }]
                        },
                        Props: {
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                anyOf: [{
                                        type: "string"
                                    }, {
                                        type: "number"
                                    }, {
                                        type: "boolean"
                                    }, {
                                        type: "object",
                                        additionalProperties: true
                                    }, {
                                        type: "array",
                                        items: true
                                    }, {}, {
                                        type: "null"
                                    }]
                            }
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    $ref: "#/$defs/Element",
                    asOpaque: true,
                    $defs: {
                        Element: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                props: {
                                    $ref: "#/$defs/Props"
                                },
                                children: {
                                    $ref: "#/$defs/RenderNode"
                                },
                                $UI: {
                                    $ref: "#/$defs/VNode"
                                }
                            },
                            required: ["type", "name", "props"]
                        },
                        VNode: {
                            type: "object",
                            properties: {
                                type: {
                                    type: "string"
                                },
                                name: {
                                    type: "string"
                                },
                                props: {
                                    $ref: "#/$defs/Props"
                                },
                                children: {
                                    $ref: "#/$defs/RenderNode"
                                },
                                $UI: {
                                    $ref: "#/$defs/VNode"
                                }
                            },
                            required: ["type", "name", "props"]
                        },
                        RenderNode: {
                            anyOf: [{
                                    type: "string"
                                }, {
                                    type: "number"
                                }, {
                                    type: "boolean"
                                }, {
                                    $ref: "#/$defs/VNode"
                                }, {
                                    type: "object",
                                    properties: {}
                                }, {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/RenderNode"
                                    }
                                }]
                        },
                        Props: {
                            type: "object",
                            properties: {},
                            additionalProperties: {
                                anyOf: [{
                                        type: "string"
                                    }, {
                                        type: "number"
                                    }, {
                                        type: "boolean"
                                    }, {
                                        type: "object",
                                        additionalProperties: true
                                    }, {
                                        type: "array",
                                        items: true
                                    }, {}, {
                                        type: "null"
                                    }]
                            }
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
                    type: "object",
                    properties: {
                        state: {
                            type: "object",
                            properties: {
                                editingId: {
                                    type: "string",
                                    asCell: true
                                }
                            },
                            required: ["editingId"]
                        },
                        item: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "string",
                                    asOpaque: true
                                }
                            },
                            required: ["id"]
                        }
                    },
                    required: ["state", "item"]
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "boolean"
                } as const satisfies __ctHelpers.JSONSchema, {
                    state: {
                        editingId: state.editingId
                    },
                    item: {
                        id: item.id
                    }
                }, ({ state, item }) => state.editingId.get() === item.id), <input value={item.name}/>, <span>{item.name}</span>)}
          </li>)), {
                state: {
                    editingId: state.editingId
                }
            })}
      </ul>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
