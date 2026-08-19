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
import { Cell, Default, handler, NAME, pattern, toSchema, UI, } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
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
const inputSchema = __cfHelpers.__cf_data({
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
} as const satisfies __cfHelpers.JSONSchema);
const outputSchema = __cfHelpers.__cf_data({
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
} as const satisfies __cfHelpers.JSONSchema);
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["writeonly"]
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
} as const satisfies __cfHelpers.JSONSchema, (event: InputEventType, { items }: {
    items: Cell<Item[]>;
}) => {
    items.push({ text: event.detail.message });
});
__cfBindVerifiedBinding(addItem, {
    sourceFile: "/test.tsx",
    position: { line: 41, col: 2 },
    bindingName: "addItem"
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
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
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 64, col: 21 }
});
// FIXTURE: pattern-with-types
// Verifies: full pattern with toSchema, handler, JSX, and .map() all transform correctly together
//   toSchema<T>() → inline JSON schema literal with Default<> mapped to "default" values
//   handler() → injects event schema and context schema with asCell on Cell<> fields
//   items.map((item, index) => JSX) → items.mapWithPattern(pattern(...), {})
//   pattern<In, Out>() → uses pre-generated inputSchema/outputSchema passed as arguments
// Context: kitchen-sink pattern with NAME, UI, handler, array .map(), and Default<> types
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    const items = __cf_pattern_input.key("items");
    const items_count = items.key("length");
    return {
        [NAME]: title,
        [UI]: (<div>
        <h3>{title}</h3>
        <p>Basic pattern</p>
        <p>Items count: {items_count}</p>
        <ul>
          {items.mapWithPattern(__cfPattern_1, {})}
        </ul>
        <cf-message-input name="Send" placeholder="Type a message..." appearance="rounded" oncf-send={addItem({ items })}/>
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 53, col: 68 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    addItem,
    __cfPattern_1
});
