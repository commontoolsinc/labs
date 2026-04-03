import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    sections: {
        tasks: {
            label: string;
        }[];
        tags: {
            name: string;
        }[];
    }[];
}
// FIXTURE: map-destructured-opaque-local-capture
// Verifies: destructured opaque locals captured by nested map callbacks stay reactive
//   const { tasks } = section → const tasks = __ct_pattern_input.key("params", "tasks")
//   nested tag callback reads tasks.length through key("length"), not plain params values
export default pattern((state) => ({
    [UI]: (<div>
      {state.key("sections").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const section = __ct_pattern_input.key("element");
            const tasks = section.key("tasks");
            return (<div>
            {section.key("tags").mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                    const tag = __ct_pattern_input.key("element");
                    const tasks = __ct_pattern_input.key("params", "tasks");
                    return (<span>
                {tag.key("name")}:{tasks.key("length")}
              </span>);
                }, {
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
                            properties: {
                                tasks: {
                                    type: "object",
                                    properties: {
                                        length: {
                                            type: "number"
                                        }
                                    },
                                    required: ["length"]
                                }
                            },
                            required: ["tasks"]
                        }
                    },
                    required: ["element", "params"]
                } as const satisfies __ctHelpers.JSONSchema, {
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
                } as const satisfies __ctHelpers.JSONSchema), {
                    tasks: {
                        length: tasks.key("length")
                    }
                })}
          </div>);
        }, {
            type: "object",
            properties: {
                element: {
                    type: "object",
                    properties: {
                        tasks: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    label: {
                                        type: "string"
                                    }
                                },
                                required: ["label"]
                            }
                        },
                        tags: {
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
                        }
                    },
                    required: ["tasks", "tags"]
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
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
        } as const satisfies __ctHelpers.JSONSchema), {})}
    </div>),
}), {
    type: "object",
    properties: {
        sections: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    tasks: {
                        type: "array",
                        items: {
                            type: "object",
                            properties: {
                                label: {
                                    type: "string"
                                }
                            },
                            required: ["label"]
                        }
                    },
                    tags: {
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
                    }
                },
                required: ["tasks", "tags"]
            }
        }
    },
    required: ["sections"]
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
