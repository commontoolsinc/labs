import * as __ctHelpers from "commontools";
import { Cell, cell, ComparableCell } from "commontools";
export default function TestCellOfNoValue() {
    // Cell.of with type argument but no value - should become Cell.of(undefined, schema)
    const _c1 = Cell.of<string>(undefined, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    const _c2 = Cell.of<number>(undefined, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    const _c3 = Cell.of<boolean>(undefined, {
        type: "boolean"
    } as const satisfies __ctHelpers.JSONSchema);
    // cell() with type argument but no value - should become cell(undefined, schema)
    const _c4 = cell<string>(undefined, {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema);
    // ComparableCell.of with type argument but no value
    const _c5 = ComparableCell.of<{
        name: string;
    }>(undefined, {
        type: "object",
        properties: {
            name: {
                type: "string"
            }
        },
        required: ["name"]
    } as const satisfies __ctHelpers.JSONSchema);
    // Mixed - some with value, some without
    const _c6 = Cell.of<string>("hello", {
        type: "string"
    } as const satisfies __ctHelpers.JSONSchema); // has value
    const _c7 = Cell.of<number>(undefined, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema); // no value
    return null;
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
