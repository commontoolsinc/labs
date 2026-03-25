import * as __cfHelpers from "commonfabric";
import { cell, pattern, handler } from "commonfabric";
// 1. Top-level
const _topLevel = cell(10, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// 2. Inside function
function regularFunction() {
    const _inFunction = cell(20, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return _inFunction;
}
// 3. Inside arrow function
const arrowFunction = () => {
    const _inArrow = cell(30, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return _inArrow;
};
// 4. Inside class method
class TestClass {
    method() {
        const _inMethod = cell(40, {
            type: "number"
        } as const satisfies __cfHelpers.JSONSchema);
        return _inMethod;
    }
}
// 5. Inside pattern
const testPattern = pattern(() => {
    const _inPattern = cell(50, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return _inPattern;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number",
    asCell: true
} as const satisfies __cfHelpers.JSONSchema);
// 6. Inside handler
const testHandler = handler(false as const satisfies __cfHelpers.JSONSchema, false as const satisfies __cfHelpers.JSONSchema, () => {
    const _inHandler = cell(60, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    return _inHandler;
});
// FIXTURE: context-variations
// Verifies: schema injection works in all code contexts and pattern/handler get their own schemas
//   cell(N) → cell(N, { type: "number" }) in top-level, function, arrow, class method, pattern, handler
//   pattern(() => ...) → pattern(() => ..., inputSchema, outputSchema)
//   handler(() => ...) → handler(inputSchema, outputSchema, () => ...)
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
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
