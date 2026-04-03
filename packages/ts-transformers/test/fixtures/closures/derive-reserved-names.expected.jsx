import * as __cfHelpers from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
// FIXTURE: derive-reserved-names
// Verifies: variables with __ct_ prefixed names are captured without special treatment
//   derive(value, fn) → derive(schema, schema, { value, __ct_reserved }, fn)
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Reserved JavaScript keyword as variable name (valid in TS with quotes)
    const __ct_reserved = Writable.of(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            value: {
                type: "number",
                asCell: true
            },
            __ct_reserved: {
                type: "number",
                asCell: true
            }
        },
        required: ["value", "__ct_reserved"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema, {
        value,
        __ct_reserved: __ct_reserved
    }, ({ value: v, __ct_reserved }) => v.get() * __ct_reserved.get());
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
