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
import { Cell, handler, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type TodoState = {
    items: Cell<string[]>;
};
type TodoEvent = {
    add: string;
};
const addTodo = handler({
    type: "object",
    properties: {
        add: {
            type: "string"
        }
    },
    required: ["add"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.items.push(event.add);
});
__cfBindVerifiedBinding(addTodo, {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 62 },
    bindingName: "addTodo"
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    const index = __cf_pattern_input.key("index");
    return <li key={index}>{item}</li>;
}, {
    type: "object",
    properties: {
        element: {
            type: "string"
        },
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
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 32, col: 27 }
});
// FIXTURE: schema-generation-builders
// Verifies: handler with generic type args generates event+state schemas; .map() becomes .mapWithPattern()
//   handler<TodoEvent, { items: Cell<string[]> }>(fn) → handler(eventSchema, stateSchema, fn)
//   state.items.map((item, index) => JSX)             → state.key("items").mapWithPattern(pattern(...), {})
//   pattern<TodoState>(fn)                            → pattern(fn, inputSchema, outputSchema)
export default __cfBindVerifiedBinding(pattern((state) => {
    return {
        [UI]: (<div>
        <button type="button" onClick={addTodo({ items: state.key("items") })}>
          Add
        </button>
        <ul>
          {state.key("items").mapWithPattern(__cfPattern_1, {})}
        </ul>
      </div>),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["cell"]
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 21, col: 34 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    addTodo,
    __cfPattern_1
});
