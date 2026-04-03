import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
// FIXTURE: pattern-computed-literal-member-default
// Verifies: literal-member destructuring defaults survive into schema defaults
//   ({ ["foo"]: foo = "fallback" }) → schema default on "foo"
export default pattern((__ct_pattern_input) => {
    const foo = __ct_pattern_input.key("foo");
    return <div>{foo}</div>;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string",
            "default": "fallback"
        },
        bar: {
            type: "string"
        }
    },
    required: ["foo", "bar"]
} as const satisfies __cfHelpers.JSONSchema, {
    anyOf: [{
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }, {
            $ref: "#/$defs/UIRenderable"
        }, {
            type: "object",
            properties: {}
        }],
    $defs: {
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
