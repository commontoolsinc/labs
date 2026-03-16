import * as __ctHelpers from "commontools";
import { Writable, derive, pattern } from "commontools";
// FIXTURE: derive-no-captures
// Verifies: derive with no closed-over variables is NOT closure-transformed
//   derive(value, fn) → derive(schema, schema, value, fn) (no capture object created)
// Context: negative test; only schema injection occurs, the 2-arg form remains structurally unchanged
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // No captures - should not be transformed
    const result = derive({
        type: "number",
        asCell: true
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema, value, (v) => v.get() * 2);
    return result;
}, false as const satisfies __ctHelpers.JSONSchema, {
    type: "number"
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
