import * as __ctHelpers from "commontools";
/**
 * Test: Actions closing over SELF with Default<> inputs
 *
 * When all input properties use Default<T, V> (not optional `?`), the piece
 * always has values for every property. This means `self` (which is the piece
 * itself) satisfies the output schema's `required` array at runtime.
 *
 * The output schema should mark `title` as required (since Default<> ensures
 * a value always exists), and the handler's context schema should mark `self`
 * as required.
 */
import { action, type Default, NAME, pattern, SELF, UI, type VNode, Writable } from "commontools";
interface TestOutput {
    [NAME]: string;
    [UI]: VNode;
    title: string;
    count: number;
}
export default pattern(({ title, [SELF]: self }) => {
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
                        type: "string",
                        asOpaque: true
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
            title: self.title
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
                $ref: "#/$defs/TestOutput",
                asOpaque: true
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
