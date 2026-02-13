import * as __ctHelpers from "commontools";
import { cell, pattern, handler } from "commontools";
// 1. Top-level
const _topLevel = cell(10, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// 2. Inside function
function regularFunction() {
    const _inFunction = cell(20, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return _inFunction;
}
// 3. Inside arrow function
const arrowFunction = () => {
    const _inArrow = cell(30, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return _inArrow;
};
// 4. Inside class method
class TestClass {
    method() {
        const _inMethod = cell(40, {
            type: "number"
        } as const satisfies __ctHelpers.JSONSchema);
        return _inMethod;
    }
}
// 5. Inside pattern
const testPattern = pattern(false as const satisfies __ctHelpers.JSONSchema, {
    type: "number",
    asCell: true
} as const satisfies __ctHelpers.JSONSchema, () => {
    const _inPattern = cell(50, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return _inPattern;
});
// 6. Inside handler
const testHandler = handler(false as const satisfies __ctHelpers.JSONSchema, false as const satisfies __ctHelpers.JSONSchema, () => {
    const _inHandler = cell(60, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    return _inHandler;
});
export default function TestContextVariations() {
    return {
        topLevel: _topLevel,
        regularFunction,
        arrowFunction,
        TestClass,
        testPattern,
        testHandler,
    };
}
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
