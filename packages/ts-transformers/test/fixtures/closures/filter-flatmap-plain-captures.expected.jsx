import * as __cfHelpers from "commonfabric";
import { pattern } from "commonfabric";
// FIXTURE: filter-flatmap-plain-captures
// Verifies: plain lexical captures in reactive filter/flatMap chains become
// params values, not reactive key(...) lookups
//   suffix/prefix literals -> __ct_pattern_input.params.{suffix,prefix}
//   items.filter(fn).flatMap(fn) -> filterWithPattern(...).flatMapWithPattern(...)
// Context: the captures are plain strings, so the lowered callbacks should not
// route them through key() ownership paths.
export default pattern((__ct_pattern_input) => {
    const items = __ct_pattern_input.key("items");
    const suffix = "!";
    const prefix = "#";
    return {
        labels: items.filterWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            const suffix = __ct_pattern_input.params.suffix;
            return __cfHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "object",
                        properties: {
                            label: {
                                type: "string"
                            }
                        },
                        required: ["label"]
                    }
                },
                required: ["item"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __cfHelpers.JSONSchema, { item: {
                    label: item.key("label")
                } }, ({ item }) => item.label.endsWith(suffix));
        }, {
            type: "object",
            properties: {
                element: {
                    type: "object",
                    properties: {
                        label: {
                            type: "string"
                        },
                        tags: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["label", "tags"]
                },
                params: {
                    type: "object",
                    properties: {
                        suffix: {
                            type: "string"
                        }
                    },
                    required: ["suffix"]
                }
            },
            required: ["element", "params"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema), {
            suffix: suffix
        }).flatMapWithPattern(__cfHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            const prefix = __ct_pattern_input.params.prefix;
            return __cfHelpers.ifElse({
                type: "number"
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                }
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "array",
                items: false
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                }
            } as const satisfies __cfHelpers.JSONSchema, item.key("tags", "length"), __cfHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "object",
                        properties: {
                            tags: {
                                type: "array",
                                items: {
                                    type: "string"
                                }
                            }
                        },
                        required: ["tags"]
                    }
                },
                required: ["item"]
            } as const satisfies __cfHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                }
            } as const satisfies __cfHelpers.JSONSchema, { item: {
                    tags: item.key("tags")
                } }, ({ item }) => [prefix + item.tags[0]]), []);
        }, {
            type: "object",
            properties: {
                element: {
                    type: "object",
                    properties: {
                        label: {
                            type: "string"
                        },
                        tags: {
                            type: "array",
                            items: {
                                type: "string"
                            }
                        }
                    },
                    required: ["label", "tags"]
                },
                params: {
                    type: "object",
                    properties: {
                        prefix: {
                            type: "string"
                        }
                    },
                    required: ["prefix"]
                }
            },
            required: ["element", "params"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __cfHelpers.JSONSchema), {
            prefix: prefix
        }),
    };
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    label: {
                        type: "string"
                    },
                    tags: {
                        type: "array",
                        items: {
                            type: "string"
                        }
                    }
                },
                required: ["label", "tags"]
            }
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        labels: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["labels"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
