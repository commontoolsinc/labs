function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { Cell, cell, ComparableCell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
// FIXTURE: cell-of-no-value
// Verifies: Cell.of/cell with type arg but no value injects undefined as first arg plus schema
//   Cell.of<string>() → Cell.of<string>(undefined, { type: "string" })
//   cell<string>() → cell<string>(undefined, { type: "string" })
//   ComparableCell.of<{ name: string }>() → ComparableCell.of<...>(undefined, { type: "object", ... })
//   Cell.of<string>("hello") → Cell.of<string>("hello", { type: "string" })
export default function TestCellOfNoValue() {
    // Cell.of with type argument but no value - should become Cell.of(undefined, schema)
    const _c1 = Cell.of<string>(undefined, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const _c2 = Cell.of<number>(undefined, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const _c3 = Cell.of<boolean>(undefined, {
        type: "boolean"
    } as const satisfies __cfHelpers.JSONSchema);
    // cell() with type argument but no value - should become cell(undefined, schema)
    const _c4 = cell<string>(undefined, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
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
    } as const satisfies __cfHelpers.JSONSchema);
    // Mixed - some with value, some without
    const _c6 = Cell.of<string>("hello", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema); // has value
    const _c7 = Cell.of<number>(undefined, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema); // no value
    return null;
}
__cfHardenFn(TestCellOfNoValue);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
