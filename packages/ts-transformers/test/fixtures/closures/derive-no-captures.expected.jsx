import * as __cfHelpers from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
// FIXTURE: derive-no-captures
// Verifies: derive with no closed-over variables is NOT closure-transformed
//   derive(value, fn) → derive(schema, schema, value, fn) (no capture object created)
// Context: negative test; only schema injection occurs, the 2-arg form remains structurally unchanged
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // No captures - should not be transformed
    const result = derive({
        type: "number",
        asCell: true
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, value, (v) => v.get() * 2);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
