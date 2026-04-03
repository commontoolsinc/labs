import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
// FIXTURE: pattern-array-destructure-param
// Verifies: top-level array destructuring in pattern params lowers to index-based key access
//   ([first]) => <div>{first}</div> → const first = __ct_pattern_input.key("0")
export default pattern((__ct_pattern_input) => {
    const first = __ct_pattern_input.key("0");
    return <div>{first}</div>;
}, {
    type: "array",
    items: {
        type: "string"
    }
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
