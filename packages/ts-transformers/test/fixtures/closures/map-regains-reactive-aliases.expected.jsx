import * as __ctHelpers from "commontools";
import { Default, computed, lift, pattern, wish } from "commontools";
const passthrough = lift({
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __ctHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __ctHelpers.JSONSchema, (items: string[]) => items);
// FIXTURE: map-regains-reactive-aliases
// Verifies: compute-owned aliases that still resolve to reactive array roots
// are rewritten back to mapWithPattern/filterWithPattern when used in pattern
// lowering sites
//   const foo = computed(() => inner); foo.map(fn)        -> foo.mapWithPattern(...)
//   const foo = passthrough(inner); foo.map(fn)           -> foo.mapWithPattern(...)
//   const foo = wish<Default<T[], []>>(...).result!; map  -> foo.mapWithPattern(...)
//   const filtered = foo.filter(fn); filtered.map(fn)     -> filterWithPattern(...).mapWithPattern(...)
//   const filtered = foo.filter(fn); filtered.map(item => item.toUpperCase())
//                                                   -> receiver-method body still lowers via derive(...)
// Context: contrasts with the existing plain-array compute fixtures where the
// callback receiver really is compute-owned plain JS data.
export default pattern((state) => {
    const inner = __ctHelpers.derive({
        type: "object",
        properties: {
            state: {
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
            }
        },
        required: ["state"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { state: {
            items: state.key("items")
        } }, ({ state }) => state.items);
    const fromComputed = __ctHelpers.derive({
        type: "object",
        properties: {
            inner: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: ["inner"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { inner: inner }, ({ inner }) => {
        const foo = __ctHelpers.derive({
            type: "object",
            properties: {
                inner: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["inner"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __ctHelpers.JSONSchema, { inner: inner }, ({ inner }) => inner);
        return foo.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return item + "!";
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema), {});
    });
    const fromLift = __ctHelpers.derive({
        type: "object",
        properties: {
            inner: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: ["inner"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { inner: inner }, ({ inner }) => {
        const foo = passthrough(inner);
        return foo.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return item + "!";
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema), {});
    });
    const fromWish = __ctHelpers.derive({
        type: "object",
        properties: {}
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, {}, () => {
        const foo = wish<Default<string[], [
        ]>>({ query: "#items" }, {
            type: "array",
            items: {
                type: "string"
            },
            "default": []
        } as const satisfies __ctHelpers.JSONSchema).result!;
        return foo.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return item + "!";
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema), {});
    });
    const fromFiltered = __ctHelpers.derive({
        type: "object",
        properties: {
            inner: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: ["inner"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { inner: inner }, ({ inner }) => {
        const foo = __ctHelpers.derive({
            type: "object",
            properties: {
                inner: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["inner"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __ctHelpers.JSONSchema, { inner: inner }, ({ inner }) => inner);
        const filtered = foo.filterWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return item.key("length") > 1;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema), {});
        return filtered.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return item + "!";
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema), {});
    });
    const fromFilteredReceiverMethod = __ctHelpers.derive({
        type: "object",
        properties: {
            inner: {
                type: "array",
                items: {
                    type: "string"
                }
            }
        },
        required: ["inner"]
    } as const satisfies __ctHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __ctHelpers.JSONSchema, { inner: inner }, ({ inner }) => {
        const foo = __ctHelpers.derive({
            type: "object",
            properties: {
                inner: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["inner"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __ctHelpers.JSONSchema, { inner: inner }, ({ inner }) => inner);
        const filtered = foo.filterWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return item.key("length") > 1;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __ctHelpers.JSONSchema), {});
        return filtered.mapWithPattern(__ctHelpers.pattern(__ct_pattern_input => {
            const item = __ct_pattern_input.key("element");
            return __ctHelpers.derive({
                type: "object",
                properties: {
                    item: {
                        type: "string"
                    }
                },
                required: ["item"]
            } as const satisfies __ctHelpers.JSONSchema, {
                type: "string"
            } as const satisfies __ctHelpers.JSONSchema, { item: item }, ({ item }) => item.toUpperCase());
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __ctHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __ctHelpers.JSONSchema), {});
    });
    return {
        fromComputed,
        fromLift,
        fromWish,
        fromFiltered,
        fromFilteredReceiverMethod,
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
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        fromComputed: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromLift: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromWish: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromFiltered: {
            type: "array",
            items: {
                type: "string"
            }
        },
        fromFilteredReceiverMethod: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["fromComputed", "fromLift", "fromWish", "fromFiltered", "fromFilteredReceiverMethod"]
} as const satisfies __ctHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
