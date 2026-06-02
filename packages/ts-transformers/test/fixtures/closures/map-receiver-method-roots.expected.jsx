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
const __cfModuleCallback_1 = __cfHardenFn(({ item }) => identity(item.toUpperCase()));
const identity = __cfHardenFn(<T,>(value: T) => value);
// FIXTURE: map-receiver-method-roots
// Verifies: receiver-method roots inside pattern-owned map callbacks lower reactively
//   item.toUpperCase()            → callback-local lift-applied computation
//   identity(item.toUpperCase())  → call-argument receiver-method root lowered reactively
export default pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return ({
        [UI]: (<div>
      {items.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return <span>{__cfHelpers.lift<{
                item: string;
            }, string>({
                type: "object",
                properties: {
                    item: {
                        type: "string"
                    }
                },
                required: ["item"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __cfHelpers.JSONSchema, ({ item }) => item.toUpperCase())({ item: item })}</span>;
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
      {items.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return <span>{__cfHelpers.lift<{
                item: string;
            }, string>({
                type: "object",
                properties: {
                    item: {
                        type: "string"
                    }
                },
                required: ["item"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __cfHelpers.JSONSchema, __cfModuleCallback_1)({ item: item })}</span>;
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
    });
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
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
