import * as __ctHelpers from "commontools";
import { SELF, pattern } from "commontools";
interface Input {
    value: string;
}
// FIXTURE: pattern-self-computed-destructure
// Verifies: destructured pattern input with SELF and renamed binding is rewritten to .key() accessors
//   ({ [SELF]: self, value: _value }) → (__ct_pattern_input) => { self = __ct_pattern_input[SELF]; _value = __ct_pattern_input.key("value"); }
// Context: Tests that the SELF symbol is accessed via bracket notation while
//   regular properties use .key(), and that renamed bindings (value: _value)
//   are handled correctly.
const _p = pattern((__ct_pattern_input) => {
    const self = __ct_pattern_input[__ctHelpers.SELF];
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "string"
        }
    },
    required: ["value"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
