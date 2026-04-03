import * as __ctHelpers from "commontools";
/**
 * TRANSFORM REPRO: helper-owned JSX IIFE final map callback captures reactive state
 * after the local receiver has been rewritten through a synthetic fallback wrapper.
 */
import { pattern, UI, VNode } from "commontools";
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
const visibleEntries = (entries: Entry[], prefix: string) => entries.filter((entry) => entry.name.startsWith(prefix));
export default pattern((__ct_pattern_input) => {
    const entries = __ct_pattern_input.key("entries");
    const prefix = __ct_pattern_input.key("prefix");
    const labelPrefix = __ct_pattern_input.key("labelPrefix");
    return ({
        [UI]: (<div>
      {(() => {
                const visible = __ctHelpers.unless({
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
                } as const satisfies __ctHelpers.JSONSchema, {
                    type: "array",
                    items: false
                } as const satisfies __ctHelpers.JSONSchema, {
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
                } as const satisfies __ctHelpers.JSONSchema, __ctHelpers.derive({
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
                } as const satisfies __ctHelpers.JSONSchema, {
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
                } as const satisfies __ctHelpers.JSONSchema, {
                    entries: entries,
                    prefix: prefix
                }, ({ entries, prefix }) => visibleEntries(entries, prefix)), []);
                return visible.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
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
                } as const satisfies __ctHelpers.JSONSchema, {
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
                } as const satisfies __ctHelpers.JSONSchema), {
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "https://commonfabric.org/schemas/vnode.json"
        }
    },
    required: ["$UI"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
