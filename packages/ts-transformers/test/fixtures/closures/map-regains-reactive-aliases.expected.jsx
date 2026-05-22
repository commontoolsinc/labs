function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { Default, computed, lift, pattern, wish } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfModuleCallback_1 = __cfHardenFn(({ inner }) => {
    const foo = passthrough(inner).for("foo", true);
    return foo.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
        const item = __cf_pattern_input.key("element");
        return item + "!";
    }, {
        type: "object",
        properties: {
            element: {
                type: "string"
            }
        },
        required: ["element"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema), {});
});
const __cfModuleCallback_2 = __cfHardenFn(() => {
    const foo = wish<Default<string[], [
    ]>>({ query: "#items" }, {
        type: "array",
        items: {
            type: "string"
        },
        "default": []
    } as const satisfies __cfHelpers.JSONSchema).result!;
    return foo.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
        const item = __cf_pattern_input.key("element");
        return item + "!";
    }, {
        type: "object",
        properties: {
            element: {
                type: "string"
            }
        },
        required: ["element"]
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "string"
    } as const satisfies __cfHelpers.JSONSchema), {});
});
const passthrough = lift({
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema, (items: string[]) => items);
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
    const inner = __cfHelpers.lift<{
        state: {
            items: string[];
        };
    }, string[]>({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, ({ state }) => state.items)({ state: {
            items: state.key("items")
        } }).for("inner", true);
    const fromComputed = __cfHelpers.lift<{
        inner: string[];
    }, string[]>({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, ({ inner }) => {
        const foo = __cfHelpers.lift<{
            inner: string[];
        }, string[]>({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __cfHelpers.JSONSchema, ({ inner }) => inner)({ inner: inner }).for("foo", true);
        return foo.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return item + "!";
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema), {});
    })({ inner: inner }).for("fromComputed", true);
    const fromLift = __cfHelpers.lift<{
        inner: string[];
    }, string[]>({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, __cfModuleCallback_1)({ inner: inner }).for("fromLift", true);
    const fromWish = __cfHelpers.lift({
        type: "object",
        properties: {}
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, __cfModuleCallback_2)({}).for("fromWish", true);
    const fromFiltered = __cfHelpers.lift<{
        inner: string[];
    }, string[]>({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, ({ inner }) => {
        const foo = __cfHelpers.lift<{
            inner: string[];
        }, string[]>({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __cfHelpers.JSONSchema, ({ inner }) => inner)({ inner: inner }).for("foo", true);
        const filtered = foo.filterWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return item.key("length") > 1;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema), {}).for("filtered", true);
        return filtered.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return item + "!";
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema), {});
    })({ inner: inner }).for("fromFiltered", true);
    const fromFilteredReceiverMethod = __cfHelpers.lift<{
        inner: string[];
    }, string[]>({
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
    } as const satisfies __cfHelpers.JSONSchema, {
        type: "array",
        items: {
            type: "string"
        }
    } as const satisfies __cfHelpers.JSONSchema, ({ inner }) => {
        const foo = __cfHelpers.lift<{
            inner: string[];
        }, string[]>({
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
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "array",
            items: {
                type: "string"
            }
        } as const satisfies __cfHelpers.JSONSchema, ({ inner }) => inner)({ inner: inner }).for("foo", true);
        const filtered = foo.filterWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return item.key("length") > 1;
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "boolean"
        } as const satisfies __cfHelpers.JSONSchema), {}).for("filtered", true);
        return filtered.mapWithPattern(__cfHelpers.pattern(__cf_pattern_input => {
            const item = __cf_pattern_input.key("element");
            return __cfHelpers.lift<{
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
            } as const satisfies __cfHelpers.JSONSchema, ({ item }) => item.toUpperCase())({ item: item }).for("__patternResult", true);
        }, {
            type: "object",
            properties: {
                element: {
                    type: "string"
                }
            },
            required: ["element"]
        } as const satisfies __cfHelpers.JSONSchema, {
            type: "string"
        } as const satisfies __cfHelpers.JSONSchema), {});
    })({ inner: inner }).for("fromFilteredReceiverMethod", true);
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
} as const satisfies __cfHelpers.JSONSchema, {
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
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
