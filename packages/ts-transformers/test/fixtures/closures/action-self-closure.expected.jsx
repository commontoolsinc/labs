function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
/**
 * Fixture: action closing over SELF requires inputs with defaults so the
 * piece data always satisfies the output schema's required properties.
 */
import { action, type Default, NAME, pattern, SELF, UI, type VNode, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface TestOutput {
    [NAME]: string;
    [UI]: VNode;
    title: string;
    count: number;
}
// FIXTURE: action-self-closure
// Verifies: action() closing over SELF captures self properties in the handler
//   action(() => console.log(self.title)) → handler(eventSchema, { self: { title } }, (_, { self }) => ...)({ self: { title: self.key("title") } })
//   action(() => { self; count.set(...) }) → handler(eventSchema, { self: TestOutput, count: asCell }, ...)({ self, count })
// Context: SELF reference requires Default<> inputs so output schema is always satisfied
export default pattern((__cf_pattern_input) => {
    const title = __cf_pattern_input.key("title");
    const self = __cf_pattern_input[__cfHelpers.SELF];
    const count = Writable.of(0, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema);
    // Action closing over `self` — works because all inputs use Default<>
    const showSelf = __cfHelpers.handler({
        type: "object",
        properties: {},
        additionalProperties: false
    } as const satisfies __cfHelpers.JSONSchema, {
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
    } as const satisfies __cfHelpers.JSONSchema, (_, { self }) => {
        console.log("self.title:", self.title);
    })({
        self: {
            title: self.key("title")
        }
    });
    // Action closing over both `self` and `count`
    const incrementWithSelf = __cfHelpers.handler({
        type: "object",
        properties: {},
        additionalProperties: false
    } as const satisfies __cfHelpers.JSONSchema, {
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
    } as const satisfies __cfHelpers.JSONSchema, (_, { self, count }) => {
        console.log("self:", self);
        count.set(count.get() + 1);
    })({
        self: self,
        count: count
    });
    return {
        [NAME]: "Action SELF Test",
        [UI]: (<div>
          <cf-button onClick={showSelf}>Show Self</cf-button>
          <cf-button onClick={incrementWithSelf}>Increment with Self</cf-button>
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
