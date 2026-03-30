import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
interface Input {
    foo: string;
    count: number;
    enabled: boolean;
}
// FIXTURE: pattern-interface-default-sibling-fields
// Verifies: interface-backed destructuring defaults keep schema defaults and non-default sibling fields
//   ({ foo = "fallback", count = 0 }) → schema defaults for foo/count
//   enabled stays present in the input schema even though it is not destructured
export default pattern((__ct_pattern_input) => {
    const foo = __ct_pattern_input.key("foo");
    const count = __ct_pattern_input.key("count");
    return (<div>
    {foo}:{count}
  </div>);
}, {
    type: "object",
    properties: {
        foo: {
            type: "string",
            "default": "fallback"
        },
        count: {
            type: "number",
            "default": 0
        },
        enabled: {
            type: "boolean"
        }
    },
    required: ["foo", "count", "enabled"]
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
