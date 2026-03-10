import * as __ctHelpers from "commontools";
/**
 * Fixture: action closing over SELF requires inputs with defaults so the
 * piece data always satisfies the output schema's required properties.
 */
import { action, type Default, NAME, pattern, SELF, UI, type VNode, Writable } from "commontools";
interface TestOutput {
    [NAME]: string;
    [UI]: VNode;
    title: string;
    count: number;
}
export default pattern((__ct_pattern_input) => {
    const title = __ct_pattern_input.key("title");
    const self = __ct_pattern_input[__ctHelpers.SELF];
    const count = Writable.of(0, {
        type: "number"
    } as const satisfies __ctHelpers.JSONSchema);
    // Action closing over `self` — works because all inputs use Default<>
    const showSelf = __ctHelpers.handler({
        type: "object",
        properties: {},
        additionalProperties: false
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            self: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    }
                },
                required: ["title"]
            }
        },
        required: ["self"]
    } as const satisfies __ctHelpers.JSONSchema, (_, { self }) => {
        console.log("self.title:", self.title);
    })({
        self: {
            title: self.key("title")
        }
    });
    // Action closing over both `self` and `count`
    const incrementWithSelf = __ctHelpers.handler({
        type: "object",
        properties: {},
        additionalProperties: false
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "object",
        properties: {
            self: {
                $ref: "#/$defs/TestOutput"
            },
            count: {
                type: "number",
                asCell: true
            }
        },
        required: ["self", "count"],
        $defs: {
            TestOutput: {
                type: "object",
                properties: {
                    title: {
                        type: "string"
                    },
                    count: {
                        type: "number"
                    },
                    $NAME: {
                        type: "string"
                    },
                    $UI: {
                        $ref: "https://commonfabric.org/schemas/vnode.json"
                    }
                },
                required: ["title", "count", "$NAME", "$UI"]
            }
        }
    } as const satisfies __ctHelpers.JSONSchema, (_, { self, count }) => {
        console.log("self:", self);
        count.set(count.get() + 1);
    })({
        self: self,
        count: count
    });
    return {
        [NAME]: "Action SELF Test",
        [UI]: (<div>
          <ct-button onClick={showSelf}>Show Self</ct-button>
          <ct-button onClick={incrementWithSelf}>Increment with Self</ct-button>
        </div>),
        title,
        count,
    };
}, {
    type: "object",
    properties: {
        title: {
            type: "string",
            "default": ""
        }
    },
    required: ["title"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        title: {
            type: "string"
        },
        count: {
            type: "number"
        },
        $NAME: {
            type: "string"
        },
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["title", "count", "$NAME", "$UI"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
