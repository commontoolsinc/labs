import * as __ctHelpers from "commontools";
import { cell, computed, Cell } from "commontools";
export default function TestComputedMapClosedOver() {
    const items: Cell<number[]> = cell([1, 2, 3]);
    const multiplier = cell(2);
    // This should NOT transform items.map to items.mapWithPattern
    // because items is a closed-over OpaqueRef that will be unwrapped by the derive
    const result = __ctHelpers.derive({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "number"
                },
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
            }
        },
        required: ["items", "multiplier"]
    } as const satisfies __ctHelpers.JSONSchema, {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "array",
        items: {
            type: "number"
        }
    } as const satisfies __ctHelpers.JSONSchema, {
        items: items,
        multiplier: multiplier
    }, ({ items, multiplier }) => items.map(x => x * multiplier.get()));
    return result;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
