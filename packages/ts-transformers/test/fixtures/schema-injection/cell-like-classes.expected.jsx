function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { cell, ComparableCell, ReadonlyCell, WriteonlyCell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// FIXTURE: cell-like-classes
// Verifies: schema injection works for cell(), ComparableCell.of(), ReadonlyCell.of(), and WriteonlyCell.of()
//   cell(100) → cell(100, { type: "number" })
//   ComparableCell.of(200) → ComparableCell.of(200, { type: "number" })
//   ReadonlyCell.of(300) → ReadonlyCell.of(300, { type: "number" })
//   WriteonlyCell.of(400) → WriteonlyCell.of(400, { type: "number" })
export default function TestCellLikeClasses() {
    // Standalone cell() function
    const _standalone = cell(100, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_standalone", true);
    // ComparableCell.of()
    const _comparable = ComparableCell.of(200, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_comparable", true);
    // ReadonlyCell.of()
    const _readonly = ReadonlyCell.of(300, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_readonly", true);
    // WriteonlyCell.of()
    const _writeonly = WriteonlyCell.of(400, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("_writeonly", true);
    return {
        standalone: _standalone,
        comparable: _comparable,
        readonly: _readonly,
        writeonly: _writeonly,
    };
}
__cfHardenFn(TestCellLikeClasses);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
