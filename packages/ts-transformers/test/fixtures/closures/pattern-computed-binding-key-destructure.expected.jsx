import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
const key = "foo" as const;
// FIXTURE: pattern-computed-binding-key-destructure
// Verifies: computed binding-name destructuring is lowered structurally
//   ({ [key]: foo }) → const foo = __ct_pattern_input.key(key)
export default pattern((__ct_pattern_input) => {
    const foo = __ct_pattern_input.key(key);
    return <div>{foo}</div>;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"]
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
