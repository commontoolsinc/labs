import * as __ctHelpers from "commontools";
/**
 * Edge case: derive with a .map() result as input, NO captures in derive callback,
 * and NO explicit type annotation on the callback parameter.
 *
 * This tests the scenario where:
 * 1. ClosureTransformer transforms .map() to .mapWithPattern()
 * 2. ClosureTransformer does NOT transform the derive (no captures)
 * 3. SchemaInjectionTransformer needs to infer the argument type from the input expression
 * 4. The input expression is now a synthetic mapWithPattern node
 *
 * Without proper typeRegistry lookup, the schema might fall back to `unknown`
 * because checker.getTypeAtLocation() doesn't know about synthetic nodes.
 */
import { Cell, derive, pattern } from "commontools";
interface Item {
    id: number;
    value: string;
}
export default pattern(({ items }) => {
    // items.map() will be transformed to items.mapWithPattern()
    // derive has NO captures, so it won't be transformed by ClosureTransformer
    // The callback param has NO explicit type annotation
    const count = derive({
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, items.mapWithPattern(__ctHelpers.pattern({
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
                    id: {
                        type: "number"
                    },
                    value: {
                        type: "string"
                    }
                },
                required: ["id", "value"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "string",
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => item.value), {}), (arr) => arr.length);
    return { count };
}, {
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
                id: {
                    type: "number"
                },
                value: {
                    type: "string"
                }
            },
            required: ["id", "value"]
        }
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asOpaque: true
        }
    },
    required: ["count"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
