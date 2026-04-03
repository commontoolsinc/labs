import * as __cfHelpers from "commonfabric";
import { SELF, pattern } from "commonfabric";
interface Input {
    value: string;
}
const _p = pattern((__ct_pattern_input) => {
    const self = __ct_pattern_input[__cfHelpers.SELF];
    const _value = __ct_pattern_input.key("value");
    return self;
}, {
    type: "object",
    properties: {
        value: {
            type: "string"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "string"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
