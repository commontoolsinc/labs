function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
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
import { Cell, derive, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    id: number;
    value: string;
}
// FIXTURE: derive-map-input-no-captures
// Verifies: derive with no captures is NOT closure-transformed, but .map() input is still rewritten
//   items.map(fn) → items.mapWithPattern(pattern(...))
//   derive(mappedInput, fn) → derive(schema, schema, mappedInput, fn) (no capture extraction)
// Context: tests interaction between map transform and derive schema injection on a synthetic node
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    // items.map() will be transformed to items.mapWithPattern()
    // derive has NO captures, so it won't be transformed by ClosureTransformer
    // The callback param has NO explicit type annotation
    const count = derive({
        type: "array",
        items: {
            type: "unknown"
        }
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, items.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
        const item = __cf_pattern_input.key("element");
        return item.key("value");
    }, {
        type: "object",
        properties: {
            element: {
                $ref: "#/$defs/Item"
            }
        },
        required: ["element"],
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema), {}), (arr) => arr.length);
    return { count };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
