import * as __ctHelpers from "commontools";
import { recipe, UI } from "commontools";
const dynamicKey = "value" as const;
interface Item {
    value: number;
    other: number;
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
                value: {
                    type: "number"
                },
                other: {
                    type: "number"
                }
            },
            required: ["value", "other"]
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
                            value: {
                                type: "number"
                            },
                            other: {
                                type: "number"
                            }
                        },
                        required: ["value", "other"]
                    }
                }
            } as const satisfies __ctHelpers.JSONSchema, ({ element, params: {} }) => {
                const __ct_val_key = dynamicKey;
                const val = __ctHelpers.derive({
                    element,
                    __ct_val_key
                }, ({ element: element, __ct_val_key: __ct_val_key }) => element[__ct_val_key]);
                "use strict";
                return <span key={val}>{__ctHelpers.derive({ val: val }, ({ val }) => val * 2)}</span>;
            }), {})}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
