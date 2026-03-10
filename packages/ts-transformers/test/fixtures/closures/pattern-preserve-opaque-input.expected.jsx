import * as __ctHelpers from "commontools";
import { pattern, type Writable, UI } from "commontools";
interface State {
    foo: string;
    bar: string;
}
export default pattern((input: Writable<State>) => {
    return {
        [UI]: <div>{__ctHelpers.derive({
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
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema, { input: input }, ({ input: input_1 }) => input.key("foo").get())}</div>,
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
