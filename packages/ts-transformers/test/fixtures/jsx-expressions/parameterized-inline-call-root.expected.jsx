function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
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
        [UI]: <div>{__cfHelpers.derive({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
