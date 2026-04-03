import * as __cfHelpers from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
// FIXTURE: derive-multiple-captures
// Verifies: two captured cells are both extracted into the derive capture object
//   derive(value, fn) → derive(schema, schema, { value, multiplier, offset }, fn)
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const multiplier = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const offset = Writable.of(5, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            multiplier: {
                type: "number",
                asCell: true
            },
            offset: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "multiplier", "offset"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value,
        multiplier: multiplier,
        offset: offset
    }, ({ value: v, multiplier, offset }) => (v.get() * multiplier.get()) + offset.get());
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
