import * as __ctHelpers from "commontools";
import { Cell, handler, recipe, UI } from "commontools";
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    state.items.push(event.add);
});
export default recipe({
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        <button type="button" onClick={addTodo({ items: state.items })}>
          Add
        </button>
        <ul>
          {state.items.mapWithPattern(__ctHelpers.recipe({
            type: "object",
            properties: {
                element: {
                    type: "string"
                },
                index: {
                    type: "number"
                },
                params: {
                    type: "object",
                    properties: {}
                }
            },
            required: ["element", "params"]
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
        } as const satisfies __ctHelpers.JSONSchema, ({ element: item, index, params: {} }) => <li key={index}>{item}</li>), {})}
        </ul>
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
