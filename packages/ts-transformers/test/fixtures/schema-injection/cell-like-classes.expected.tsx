import * as __ctHelpers from "commontools";
import { cell, ComparableCell, ReadonlyCell, WriteonlyCell } from "commontools";
export default function TestCellLikeClasses() {
    // Standalone cell() function
    const _standalone = cell(100, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // ComparableCell.of()
    const _comparable = ComparableCell.of(200, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // ReadonlyCell.of()
    const _readonly = ReadonlyCell.of(300, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // WriteonlyCell.of()
    const _writeonly = WriteonlyCell.of(400, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return {
        standalone: _standalone,
        comparable: _comparable,
        readonly: _readonly,
        writeonly: _writeonly,
    };
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
