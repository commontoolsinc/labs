import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
interface Tag {
    id: number;
    name: string;
}
interface Item {
    id: number;
    name: string;
    tags: Tag[];
}
interface State {
    items: Item[];
    prefix: string;
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
        prefix: {
            type: "string"
        }
    },
    required: ["items", "prefix"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "number"
                },
                name: {
                    type: "string"
                },
                tags: {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Tag"
                    }
                }
            },
            required: ["id", "name", "tags"]
        },
        Tag: {
            type: "object",
            properties: {
                id: {
                    type: "number"
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
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "#/$defs/VNode"
                }, {
                    $ref: "#/$defs/VNodeResult"
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
                    $ref: "#/$defs/VNode"
                }
            },
            required: ["$UI"]
        },
        VNodeResult: {
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
                    $ref: "#/$defs/PropsResult"
                },
                children: {
                    type: "array",
                    items: {
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
                                $ref: "#/$defs/VNodeResult"
                            }, {
                                type: "null"
                            }]
                    }
                },
                $UI: {
                    $ref: "#/$defs/VNodeResult"
                }
            },
            required: ["type", "name", "props"]
        },
        PropsResult: {
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
                        asStream: true
                    }, {
                        type: "null"
                    }]
            }
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
                    $ref: "#/$defs/VNodeResult"
                }, {
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
                }, {
                    type: "object",
                    properties: {}
                }, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/RenderNode"
                    }
                }, {
                    type: "null"
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
        [UI]: (<div>
        {/* Outer map captures state.prefix, inner map closes over item from outer callback */}
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
                                    prefix: {
                                        type: "string",
                                        asOpaque: true
                                    }
                                },
                                required: ["prefix"]
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
                                type: "number"
                            },
                            name: {
                                type: "string"
                            },
                            tags: {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/Tag"
                                }
                            }
                        },
                        required: ["id", "name", "tags"]
                    },
                    Tag: {
                        type: "object",
                        properties: {
                            id: {
                                type: "number"
                            },
                            name: {
                                type: "string"
                            }
                        },
                        required: ["id", "name"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                anyOf: [{
                        $ref: "#/$defs/VNode"
                    }, {
                        $ref: "#/$defs/VNodeResult"
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
                                $ref: "#/$defs/VNode"
                            }
                        },
                        required: ["$UI"]
                    },
                    VNodeResult: {
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
                                $ref: "#/$defs/PropsResult"
                            },
                            children: {
                                type: "array",
                                items: {
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
                                            $ref: "#/$defs/VNodeResult"
                                        }, {
                                            type: "null"
                                        }]
                                }
                            },
                            $UI: {
                                $ref: "#/$defs/VNodeResult"
                            }
                        },
                        required: ["type", "name", "props"]
                    },
                    PropsResult: {
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
                                    asStream: true
                                }, {
                                    type: "null"
                                }]
                        }
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
                                $ref: "#/$defs/VNodeResult"
                            }, {
                                type: "object",
                                properties: {}
                            }, {
                                $ref: "#/$defs/UIRenderable",
                                asOpaque: true
                            }, {
                                type: "object",
                                properties: {}
                            }, {
                                type: "array",
                                items: {
                                    $ref: "#/$defs/RenderNode"
                                }
                            }, {
                                type: "null"
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: { state } }) => (<div>
            {state.prefix}: {item.name}
            <ul>
              {item.tags.mapWithPattern(__ctHelpers.recipe({
                    type: "object",
                    properties: {
                        element: {
                            $ref: "#/$defs/Tag"
                        },
                        params: {
                            type: "object",
                            properties: {
                                item: {
                                    type: "object",
                                    properties: {
                                        name: {
                                            type: "string",
                                            asOpaque: true
                                        }
                                    },
                                    required: ["name"]
                                }
                            },
                            required: ["item"]
                        }
                    },
                    required: ["element", "params"],
                    $defs: {
                        Tag: {
                            type: "object",
                            properties: {
                                id: {
                                    type: "number"
                                },
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["id", "name"]
                        }
                    }
                } as const satisfies __ctHelpers.JSONSchema, {
                    anyOf: [{
                            $ref: "#/$defs/VNode"
                        }, {
                            $ref: "#/$defs/VNodeResult"
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
                                    $ref: "#/$defs/VNode"
                                }
                            },
                            required: ["$UI"]
                        },
                        VNodeResult: {
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
                                    $ref: "#/$defs/PropsResult"
                                },
                                children: {
                                    type: "array",
                                    items: {
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
                                                $ref: "#/$defs/VNodeResult"
                                            }, {
                                                type: "null"
                                            }]
                                    }
                                },
                                $UI: {
                                    $ref: "#/$defs/VNodeResult"
                                }
                            },
                            required: ["type", "name", "props"]
                        },
                        PropsResult: {
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
                                        asStream: true
                                    }, {
                                        type: "null"
                                    }]
                            }
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
                                    $ref: "#/$defs/VNodeResult"
                                }, {
                                    type: "object",
                                    properties: {}
                                }, {
                                    $ref: "#/$defs/UIRenderable",
                                    asOpaque: true
                                }, {
                                    type: "object",
                                    properties: {}
                                }, {
                                    type: "array",
                                    items: {
                                        $ref: "#/$defs/RenderNode"
                                    }
                                }, {
                                    type: "null"
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
                } as const satisfies __ctHelpers.JSONSchema, ({ element: tag, params: { item } }) => (<li>{item.name} - {tag.name}</li>)), {
                    item: {
                        name: item.name
                    }
                })}
            </ul>
          </div>)), {
                state: {
                    prefix: state.prefix
                }
            })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
