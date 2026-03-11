import * as __ctHelpers from "commontools";
import { derive } from "commontools";
declare const flag: boolean;
// FIXTURE: schema-generation-derive-multiple-returns
// Verifies: derive() with multiple return paths infers a union output schema
//   derive(flag, fn) → derive({ type: "boolean" }, { enum: ["hello", 42] }, flag, fn)
// Context: Callback has two return statements (string and number); output schema is an enum union
// Function with multiple return statements - should infer string | number
export const multiReturn = derive({
    type: "boolean"
} as const satisfies __ctHelpers.JSONSchema, {
    "enum": ["hello", 42]
} as const satisfies __ctHelpers.JSONSchema, flag, (value) => {
    if (value) {
        return "hello";
    }
    return 42;
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
