import * as __ctHelpers from "commontools";
import { cell, recipe, UI } from "commontools";
export default recipe(false as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (_state: any) => {
    const items = cell([{ name: "apple" }, { name: "banana" }], {
        type: "array",
        items: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    } as const satisfies __ctHelpers.JSONSchema);
    const showList = cell(true, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        [UI]: (<div>
        {__ctHelpers.derive({
            type: "object",
            properties: {
                showList: {
                    type: "boolean",
                    asCell: true
                },
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    },
                    asCell: true
                }
            },
            required: ["showList", "items"]
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
        } as const satisfies __ctHelpers.JSONSchema, {
            showList: showList,
            items: items
        }, ({ showList, items }) => showList && (<div>
            {items.mapWithPattern(__ctHelpers.recipe({
                type: "object",
                properties: {
                    element: {
                        type: "object",
                        properties: {
                            name: {
                                type: "string"
                            }
                        },
                        required: ["name"]
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"]
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => (<div>
                {__ctHelpers.derive({
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
            } as const satisfies __ctHelpers.JSONSchema, { item: {
                    name: item.name
                } }, ({ item }) => item.name && <span>{item.name}</span>)}
              </div>)), {})}
          </div>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
