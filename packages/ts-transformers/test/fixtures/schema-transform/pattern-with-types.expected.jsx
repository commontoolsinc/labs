import * as __ctHelpers from "commontools";
import { Cell, Default, handler, NAME, pattern, toSchema, UI, } from "commontools";
import "commontools/schema";
interface Item {
    text: Default<string, "">;
}
interface InputSchemaInterface {
    title: Default<string, "untitled">;
    items: Default<Item[], [
    ]>;
}
interface OutputSchemaInterface extends InputSchemaInterface {
    items_count: number;
}
type InputEventType = {
    detail: {
        message: string;
    };
};
const inputSchema = {
    type: "object",
    properties: {
        title: {
            type: "string",
            "default": "untitled"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": []
        }
    },
    required: ["title", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema;
const outputSchema = {
    type: "object",
    properties: {
        items_count: {
            type: "number"
        },
        title: {
            type: "string",
            "default": "untitled"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": []
        }
    },
    required: ["items_count", "title", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema;
// Handler that logs the message event
const addItem = handler // <
({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                message: {
                    type: "string"
                }
            },
            required: ["message"]
        }
    },
    required: ["detail"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: true
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (event: InputEventType, { items }: {
    items: Cell<Item[]>;
}) => {
    items.push({ text: event.detail.message });
});
// FIXTURE: pattern-with-types
// Verifies: full pattern with toSchema, handler, JSX, and .map() all transform correctly together
//   toSchema<T>() → inline JSON schema literal with Default<> mapped to "default" values
//   handler() → injects event schema and context schema with asCell on Cell<> fields
//   items.map((item, index) => JSX) → items.mapWithPattern(pattern(...), {})
//   pattern<In, Out>() → uses pre-generated inputSchema/outputSchema passed as arguments
// Context: kitchen-sink pattern with NAME, UI, handler, array .map(), and Default<> types
export default pattern((__ct_pattern_input) => {
    const title = __ct_pattern_input.key("title");
    const items = __ct_pattern_input.key("items");
    const items_count = items.key("length");
    return {
        [NAME]: title,
        [UI]: (<div>
        <h3>{title}</h3>
        <p>Basic pattern</p>
        <p>Items count: {items_count}</p>
        <ul>
          {items.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
                const item = __ct_pattern_input.key("element");
                const index = __ct_pattern_input.key("index");
                return (<li key={index}>{item.key("text")}</li>);
            }, {
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    index: {
                        type: "number"
                    }
                },
                required: ["element"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            text: {
                                type: "string",
                                "default": ""
                            }
                        },
                        required: ["text"]
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
            } as const satisfies __ctHelpers.JSONSchema), {})}
        </ul>
        <ct-message-input name="Send" placeholder="Type a message..." appearance="rounded" onct-send={addItem({ items })}/>
      </div>),
        title,
        items,
        items_count,
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string",
            "default": "untitled"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": []
        }
    },
    required: ["title", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        items_count: {
            type: "number"
        },
        title: {
            type: "string",
            "default": "untitled"
        },
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            "default": []
        }
    },
    required: ["items_count", "title", "items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string",
                    "default": ""
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
