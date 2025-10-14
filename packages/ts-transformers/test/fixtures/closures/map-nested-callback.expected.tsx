import * as __ctHelpers from "commontools";
import { h, recipe, UI } from "commontools";
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
    $schema: "https://json-schema.org/draft/2020-12/schema",
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {/* Outer map captures state.prefix, inner map closes over item from outer callback */}
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
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
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { prefix } }) => (<div>
            {prefix}: {element.name}
            <ul>
              {element.tags.mapWithPattern(__ctHelpers.recipe({
                    $schema: "https://json-schema.org/draft/2020-12/schema",
                    type: "object",
                    properties: {
                        element: {
                            $ref: "#/$defs/Tag"
                        },
                        params: {
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
                } as const satisfies __ctHelpers.JSONSchema, ({ element, params: { name } }) => (<li>{name} - {element.name}</li>)), { name: element.name })}
            </ul>
          </div>)), { prefix: state.prefix })}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
