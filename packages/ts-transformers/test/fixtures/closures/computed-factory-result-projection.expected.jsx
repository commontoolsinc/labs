function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { computed, Default, NAME, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface ListItem {
    id: string;
    done: boolean | Default<false>;
    label: Default<string, "">;
    // deno-lint-ignore no-explicit-any
    [extra: string]: any;
}
interface ListOutput {
    [NAME]: string;
    items: ListItem[];
    total: number;
}
interface ListInput {
    seed?: Default<string, "">;
}
const __cfLift_1 = __cfHelpers.lift<{
    items: {
        length: number;
    };
}, number>(({ items }) => items.length, {
    type: "object",
    properties: {
        items: {
            type: "object",
            properties: {
                length: {
                    type: "number"
                }
            },
            required: ["length"]
        }
    },
    required: ["items"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
const List = pattern(() => {
    const items: ListItem[] = [];
    return {
        [NAME]: "list",
        items,
        total: __cfLift_1({ items: {
                length: items.length
            } }),
    };
}, {
    type: "object",
    properties: {
        seed: {
            type: "string",
            "default": ""
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/ListItem"
            }
        },
        total: {
            type: "number"
        },
        $NAME: {
            type: "string"
        }
    },
    required: ["items", "total", "$NAME"],
    $defs: {
        ListItem: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                done: {
                    type: "boolean",
                    "default": false
                },
                label: {
                    type: "string",
                    "default": ""
                }
            },
            additionalProperties: true,
            required: ["id", "done", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_2 = __cfHelpers.lift<{
    list: {
        items: {
            done: boolean | __cfHelpers.Default<false>;
        }[];
    };
}, boolean>(({ list }) => list.items[0]?.done === true, {
    type: "object",
    properties: {
        list: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            done: {
                                type: "boolean",
                                "default": false
                            }
                        },
                        required: ["done"]
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["list"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_3 = __cfHelpers.lift<{
    list: {
        items: {
            label: __cfHelpers.Default<string, "">;
        }[];
    };
}, boolean>(({ list }) => list.items[2]?.label === "Gamma", {
    type: "object",
    properties: {
        list: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            label: {
                                type: "string",
                                "default": ""
                            }
                        },
                        required: ["label"]
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["list"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_4 = __cfHelpers.lift<{
    list: {
        items: {
            priority?: any;
        }[];
    };
}, boolean>(({ list }) => list.items[2]?.priority === 9, {
    type: "object",
    properties: {
        list: {
            type: "object",
            properties: {
                items: {
                    type: "array",
                    items: {
                        type: "object",
                        properties: {
                            priority: true
                        }
                    }
                }
            },
            required: ["items"]
        }
    },
    required: ["list"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: computed-factory-result-projection
// Pins lift-capture shrinking through an UNSTRIPPED factory result type (the
// capture's inferred type node prints named interface references, which carry
// their symbol only on the synthesized identifier — see
// tryGetDeclaredTypeFromSynthesizedName). Two behaviors guarded here:
//   1. A declared-key read projects through the named reference and keeps the
//      authored `Default<...>` alias, so the schema keeps `"default"` (and
//      the projected `Default<string, "">` literal prints from its own text;
//      the cross-file variant of that print is unit-tested next to
//      cloneTypeNodeDeepForEmission).
//   2. An index-signature key read (`priority`) must NOT be marked required —
//      items that legitimately omit the key would fail schema validation
//      (main regression: editable-list assert_extra_passthrough).
export default pattern(() => {
    const list = List({});
    const firstDone = __cfLift_2({ list: {
            items: list.key("items")
        } }).for("firstDone", true);
    const labelGamma = __cfLift_3({ list: {
            items: list.key("items")
        } }).for("labelGamma", true);
    const extraPassthrough = __cfLift_4({ list: {
            items: list.key("items")
        } }).for("extraPassthrough", true);
    return {
        firstDone,
        labelGamma,
        extraPassthrough,
    };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        firstDone: {
            type: "boolean"
        },
        labelGamma: {
            type: "boolean"
        },
        extraPassthrough: {
            type: "boolean"
        }
    },
    required: ["firstDone", "labelGamma", "extraPassthrough"]
} as const satisfies __cfHelpers.JSONSchema);
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    List,
    __cfLift_1,
    __cfLift_2,
    __cfLift_3,
    __cfLift_4
});
