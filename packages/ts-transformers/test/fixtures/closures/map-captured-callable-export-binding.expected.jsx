function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    items: string[];
}
// FIXTURE: map-captured-callable-export-binding
// Verifies: array-method callback lowering should not route captured plain
// callables through callback params/state. The helper should remain lexical.
function makePattern(helper: (value: string) => string) {
    return pattern((__cf_pattern_input) => {
        const items = __cf_pattern_input.key("items");
        return {
            [UI]: (<div>
          {items.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
                const item = __cf_pattern_input.key("element");
                return <span>{__cfHelpers.derive({
                    type: "object",
                    properties: {
                        item: {
                            type: "string"
                        }
                    },
                    required: ["item"]
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "string"
                } as const satisfies __cfHelpers.JSONSchema, { item: item }, ({ item }) => helper(item))}</span>;
            }, {
                type: "object",
                properties: {
                    element: {
                        type: "string"
                    }
                },
                required: ["element"]
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
            } as const satisfies __cfHelpers.JSONSchema), {})}
        </div>),
        };
    }, {
        type: "object",
        properties: {
            items: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: ["items"]
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
}
__cfHardenFn(makePattern);
const helper = __cfHardenFn((value: string) => value.toUpperCase());
const myPattern = __cfHelpers.__cf_data(makePattern(helper));
export default myPattern;
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
