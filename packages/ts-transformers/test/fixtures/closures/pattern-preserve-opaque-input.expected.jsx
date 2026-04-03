import * as __cfHelpers from "commonfabric";
import { pattern, type Writable, UI } from "commonfabric";
interface State {
    foo: string;
    bar: string;
}
// FIXTURE: pattern-preserve-opaque-input
// Verifies: Writable<T> pattern input is preserved as an opaque ref, with JSX .get() wrapped in derive
//   input.key("foo").get() in JSX → derive({ input }, ({ input }) => input.key("foo").get())
// Context: When the pattern parameter is typed as Writable<State>, the input
//   schema uses asOpaque: true. The .get() call inside JSX is not in a safe
//   reactive context, so it gets wrapped in a derive.
export default pattern((input: Writable<State>) => {
    return {
        [UI]: <div>{__cfHelpers.derive({
            type: "object",
            properties: {
                input: {
                    $ref: "#/$defs/State",
                    asCell: true
                }
            },
            required: ["input"],
            $defs: {
                State: {
                    type: "object",
                    properties: {
                        foo: {
                            type: "string"
                        },
                        bar: {
                            type: "string"
                        }
                    },
                    required: ["foo", "bar"]
                }
            }
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema, { input: input }, ({ input: input_1 }) => input.key("foo").get())}</div>,
    };
}, {
    $ref: "#/$defs/State",
    $defs: {
        State: {
            type: "object",
            properties: {
                foo: {
                    type: "string"
                },
                bar: {
                    type: "string"
                }
            },
            required: ["foo", "bar"]
        }
    }
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
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
