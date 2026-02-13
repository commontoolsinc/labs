import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    multiplier: number;
}
export default pattern({
    type: "object",
    properties: {
        multiplier: {
            type: "number"
        }
    },
    required: ["multiplier"]
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
                    type: "object",
                    properties: {}
                }, {
                    $ref: "#/$defs/UIRenderable",
                    asOpaque: true
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
} as const satisfies __ctHelpers.JSONSchema, (state) => {
    const plainArray = [1, 2, 3, 4, 5];
    return {
        [UI]: (<div>
        {/* Plain array should NOT be transformed, even with captures */}
        {plainArray.map((n) => (<span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    n: {
                        type: "number"
                    },
                    state: {
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number",
                                asOpaque: true
                            }
                        },
                        required: ["multiplier"]
                    }
                },
                required: ["n", "state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                n: n,
                state: {
                    multiplier: state.multiplier
                }
            }, ({ n, state }) => n * state.multiplier)}</span>))}
      </div>),
    };
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
