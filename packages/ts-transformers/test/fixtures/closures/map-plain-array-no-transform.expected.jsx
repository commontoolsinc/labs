import * as __ctHelpers from "commontools";
import { pattern, UI } from "commontools";
interface State {
    multiplier: number;
}
// FIXTURE: map-plain-array-no-transform
// Verifies: .map() on a plain (non-reactive) array is NOT transformed to mapWithPattern
//   plainArray.map(fn) → plainArray.map(fn) (unchanged)
//   nested JSX-local reactive expressions inside the callback still lower via derive()
// Context: NEGATIVE TEST for callback-root ownership -- the array is a local literal [1,2,3,4,5], not a reactive Cell array
export default pattern((state) => {
    const plainArray = [1, 2, 3, 4, 5];
    return {
        [UI]: (<div>
        {/* Plain array should NOT be transformed, even with captures */}
        {plainArray.map((n) => (<span>{__ctHelpers.derive({
                type: "object",
                properties: {
                    state: {
                        type: "object",
                        properties: {
                            multiplier: {
                                type: "number"
                            }
                        },
                        required: ["multiplier"]
                    }
                },
                required: ["state"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, { state: {
                    multiplier: state.multiplier
                } }, ({ state }) => n * state.multiplier)}</span>))}
      </div>),
    };
}, {
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
