import * as __cfHelpers from "commonfabric";
import { Writable, derive, pattern } from "commonfabric";
// FIXTURE: derive-template-literal
// Verifies: a captured cell used inside a template literal expression is extracted
//   derive(value, fn) → derive(schema, schema, { value, prefix }, fn)
export default pattern(() => {
    const value = Writable.of(10, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    const prefix = Writable.of("Value: ", {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema);
    const result = __cfHelpers.derive({
        type: "object",
        properties: {
            prefix: {
                type: "string",
                asCell: true
            },
            value: {
                type: "number",
                asCell: true
            }
        },
        required: ["prefix", "value"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema, {
        value,
        prefix: prefix
    }, ({ value: v, prefix }) => `${prefix.get()}${v}`);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
