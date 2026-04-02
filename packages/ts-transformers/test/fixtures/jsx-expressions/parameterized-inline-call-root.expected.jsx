import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
// FIXTURE: parameterized-inline-call-root
// Verifies: helper-owned parameterized inline-function call roots lower as a
// shared post-closure derive around the whole call, not as a derive inside the
// inline function body that leaves the reactive argument outside.
//   ((value) => prefix + value)(count)
//     -> derive(..., { prefix, count }, ({ prefix, count }) => ((value) => prefix + value)(count))
export default pattern((__ct_pattern_input) => {
    const prefix = __ct_pattern_input.key("prefix");
    const count = __ct_pattern_input.key("count");
    return ({
        [UI]: <div>{__ctHelpers.derive({
            type: "object",
            properties: {
                prefix: {
                    type: "string"
                },
                count: {
                    type: "number"
                }
            },
            required: ["prefix", "count"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, {
            prefix: prefix,
            count: count
        }, ({ prefix, count }) => ((value: number) => prefix + value)(count))}</div>,
    });
}, {
    type: "object",
    properties: {
        prefix: {
            type: "string"
        },
        count: {
            type: "number"
        }
    },
    required: ["prefix", "count"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
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
