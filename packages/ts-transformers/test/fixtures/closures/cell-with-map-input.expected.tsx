import * as __ctHelpers from "commontools";
/**
 * Edge case: cell() with a .map() result as initial value.
 *
 * This tests the scenario where:
 * 1. ClosureTransformer transforms .map() to .mapWithPattern()
 * 2. SchemaInjectionTransformer needs to infer the value type from the input expression
 * 3. The input expression is now a synthetic mapWithPattern node
 *
 * Without proper typeRegistry lookup, the schema might fall back to `unknown`
 * because checker.getTypeAtLocation() doesn't know about synthetic nodes.
 */
import { Cell, cell, pattern } from "commontools";
interface Item {
    id: number;
    value: string;
}
export default pattern(({ items }) => {
    // items.map() will be transformed to items.mapWithPattern()
    // cell() needs to infer the type from this synthetic node
    const mappedCell = cell(items.mapWithPattern(__ctHelpers.recipe({
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
    } as const satisfies __ctHelpers.JSONSchema, ({ element: item, params: {} }) => item.value), {}), {
        type: "array",
        items: {
            type: "string"
        },
        asOpaque: true
    } as const satisfies __ctHelpers.JSONSchema);
    return { mappedCell };
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
        mappedCell: {
            type: "array",
            items: {
                type: "string"
            },
            asOpaque: true,
            asCell: true
        }
    },
    required: ["mappedCell"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
