import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
function dynamicKey(): "value" {
    return "value";
}
interface Item {
    foo: number;
    value: number;
}
interface State {
    items: Item[];
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
        }
    },
    required: ["items"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                foo: {
                    type: "number"
                },
                value: {
                    type: "number"
                }
            },
            required: ["foo", "value"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    return {
        [UI]: (<div>
        {state.items.mapWithPattern(__ctHelpers.recipe({
                $schema: "https://json-schema.org/draft/2020-12/schema",
                type: "object",
                properties: {
                    element: {
                        $ref: "#/$defs/Item"
                    },
                    params: {
                        type: "object",
                        properties: {}
                    }
                },
                required: ["element", "params"],
                $defs: {
                    Item: {
                        type: "object",
                        properties: {
                            foo: {
                                type: "number"
                            },
                            value: {
                                type: "number"
                            }
                        },
                        required: ["foo", "value"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => {
                const __ct_val_key = dynamicKey();
                const { foo } = element;
                const val = __ctHelpers.derive({
                    element: element,
                    __ct_val_key: __ct_val_key
                }, ({ element, __ct_val_key }) => element[__ct_val_key]);
                return (<span>{__ctHelpers.derive({
                    foo: foo,
                    val: val
                }, ({ foo, val }) => foo + val)}</span>);
            }), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
