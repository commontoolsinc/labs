import * as __ctHelpers from "commontools";
import { pattern } from "commontools";
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
        labels: items.filterWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            const suffix = __ct_pattern_input.params.suffix;
            return __ctHelpers.derive({
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
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "boolean"
            } as const satisfies __ctHelpers.JSONSchema, { item: {
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
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema), {
            suffix: suffix
        }).flatMapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            const prefix = __ct_pattern_input.params.prefix;
            return __ctHelpers.ifElse({
                type: "number"
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                }
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: false
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                }
            } as const satisfies __ctHelpers.JSONSchema, item.key("tags", "length"), __ctHelpers.derive({
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
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "array",
                items: {
                    type: "string"
                }
            } as const satisfies __ctHelpers.JSONSchema, { item: {
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
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __ctHelpers.JSONSchema), {
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
