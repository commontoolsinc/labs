function __ctHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __ctHelpers as __cfHelpers } from "commonfabric";
/**
 * TRANSFORM REPRO: helper-owned JSX IIFE final map callback captures reactive state
 * after the local receiver has been rewritten through a synthetic fallback wrapper.
 */
import { pattern, UI, VNode } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __ctAmdHooks = undefined;
interface Entry {
    name: string;
}
interface Input {
    entries: Entry[];
    prefix: string;
    labelPrefix: string;
}
interface Output {
    [UI]: VNode;
}
const visibleEntries = __ctHardenFn((entries: Entry[], prefix: string) => entries.filter((entry) => entry.name.startsWith(prefix)));
export default pattern((__ct_pattern_input) => {
    const entries = __ct_pattern_input.key("entries");
    const prefix = __ct_pattern_input.key("prefix");
    const labelPrefix = __ct_pattern_input.key("labelPrefix");
    return ({
        [UI]: (<div>
      {(() => {
                const visible = __cfHelpers.unless({
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    },
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: false
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    },
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, __cfHelpers.derive({
                    type: "object",
                    properties: {
                        entries: {
                            type: "array",
                            items: {
                                $ref: "#/$defs/Entry"
                            }
                        },
                        prefix: {
                            type: "string"
                        }
                    },
                    required: ["entries", "prefix"],
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    type: "array",
                    items: {
                        $ref: "#/$defs/Entry"
                    },
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
                } as const satisfies __cfHelpers.JSONSchema, {
                    entries: entries,
                    prefix: prefix
                }, ({ entries, prefix }) => visibleEntries(entries, prefix)), []);
                return visible.mapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
                    const entry = __ct_pattern_input.key("element");
                    const labelPrefix = __ct_pattern_input.key("params", "labelPrefix");
                    return (<button type="button">
            {labelPrefix}:{entry.key("name")}
          </button>);
                }, {
                    type: "object",
                    properties: {
                        element: {
                            $ref: "#/$defs/Entry"
                        },
                        params: {
                            type: "object",
                            properties: {
                                labelPrefix: {
                                    type: "string"
                                }
                            },
                            required: ["labelPrefix"]
                        }
                    },
                    required: ["element", "params"],
                    $defs: {
                        Entry: {
                            type: "object",
                            properties: {
                                name: {
                                    type: "string"
                                }
                            },
                            required: ["name"]
                        }
                    }
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
                } as const satisfies __cfHelpers.JSONSchema), {
                    labelPrefix: labelPrefix
                });
            })()}
    </div>),
    });
}, {
    type: "object",
    properties: {
        entries: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        },
        prefix: {
            type: "string"
        },
        labelPrefix: {
            type: "string"
        }
    },
    required: ["entries", "prefix", "labelPrefix"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                }
            },
            required: ["name"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__ctHardenFn(h);
