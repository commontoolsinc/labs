import * as __cfHelpers from "commonfabric";
import { Cell, handler, pattern, UI } from "commonfabric";
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
            asCell: true
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.items.push(event.add);
});
// FIXTURE: schema-generation-builders
// Verifies: handler with generic type args generates event+state schemas; .map() becomes .mapWithPattern()
//   handler<TodoEvent, { items: Cell<string[]> }>(fn) → handler(eventSchema, stateSchema, fn)
//   state.items.map((item, index) => JSX)             → state.key("items").mapWithPattern(pattern(...), {})
//   pattern<TodoState>(fn)                            → pattern(fn, inputSchema, outputSchema)
export default pattern((state) => {
    return {
        [UI]: (<div>
        <button type="button" onClick={addTodo({ items: state.key("items") })}>
          Add
        </button>
        <ul>
          {state.key("items").mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            const index = __ct_pattern_input.key("index");
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
        } as const satisfies __cfHelpers.JSONSchema), {})}
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
            asCell: true
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
