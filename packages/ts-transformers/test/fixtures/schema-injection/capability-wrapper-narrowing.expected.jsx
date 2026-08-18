function __cfBindVerifiedBinding(value: any, metadata: any) {
    if (value && (typeof value === "object" || typeof value === "function") && Object.isExtensible(value)) {
        Object.defineProperty(value, "__cfVerifiedBindingIdentity", {
            value: metadata,
            configurable: true
        });
    }
    if (value && (typeof value === "object" || typeof value === "function") && typeof value.implementation === "function") {
        var implementation = value.implementation;
        if (implementation && (typeof implementation === "object" || typeof implementation === "function") && Object.isExtensible(implementation)) {
            Object.defineProperty(implementation, "__cfVerifiedBindingIdentity", {
                value: metadata,
                configurable: true
            });
        }
    }
    return value;
}
function __cfHardenFn(fn: Function) {
    Object.freeze(fn);
    const prototype = fn.prototype;
    if (prototype && typeof prototype === "object") {
        Object.freeze(prototype);
    }
    return fn;
}
import { __cfHelpers } from "commonfabric";
import { lift, type Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type Profile = {
    name: string;
    email: string;
};
type Item = {
    id: string;
    label: string;
};
type State = {
    foo: string;
    profile: Profile;
    items: Item[];
    unused: string;
};
// FIXTURE: capability-wrapper-narrowing
// Verifies: lift inputs narrow from Writable<> to the least capable cell
// wrapper required by callback usage.
const readOnly = lift((input: Writable<State>) => input.key("foo").get(), {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["readonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(readOnly, {
    sourceFile: "/test.tsx",
    position: { line: 25, col: 22 },
    bindingName: "readOnly"
});
const setOnly = lift((input: Writable<State>) => {
    input.key("foo").set("updated");
    return 1;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["writeonly"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(setOnly, {
    sourceFile: "/test.tsx",
    position: { line: 27, col: 21 },
    bindingName: "setOnly"
});
const updateOnly = lift((input: Writable<State>) => {
    input.key("profile").update({ name: "Ada" });
    return 1;
}, {
    type: "object",
    properties: {
        profile: {
            $ref: "#/$defs/Profile"
        }
    },
    required: ["profile"],
    asCell: ["writeonly"],
    $defs: {
        Profile: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                email: {
                    type: "string"
                }
            },
            required: ["name", "email"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(updateOnly, {
    sourceFile: "/test.tsx",
    position: { line: 32, col: 24 },
    bindingName: "updateOnly"
});
const pushOnly = lift((input: Writable<State>) => {
    input.key("items").push({ id: "1", label: "First" });
    return 1;
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            }
        }
    },
    required: ["items"],
    asCell: ["writeonly"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(pushOnly, {
    sourceFile: "/test.tsx",
    position: { line: 37, col: 22 },
    bindingName: "pushOnly"
});
const readWrite = lift((input: Writable<State>) => {
    input.key("foo").set(input.key("foo").get().toUpperCase());
    return 1;
}, {
    type: "object",
    properties: {
        foo: {
            type: "string"
        }
    },
    required: ["foo"],
    asCell: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(readWrite, {
    sourceFile: "/test.tsx",
    position: { line: 42, col: 23 },
    bindingName: "readWrite"
});
const comparable = lift((input: Writable<State>) => input.equals(input), {
    type: "unknown",
    asCell: ["comparable"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "boolean"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(comparable, {
    sourceFile: "/test.tsx",
    position: { line: 47, col: 24 },
    bindingName: "comparable"
});
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return item.key("id");
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Item"
        }
    },
    required: ["element"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 50, col: 12 }
});
const opaqueMap = lift((input: Writable<Item[]>) => input.mapWithPattern(__cfPattern_1, {}), {
    type: "array",
    items: {
        $ref: "#/$defs/Item"
    },
    asCell: ["opaque"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                id: {
                    type: "string"
                },
                label: {
                    type: "string"
                }
            },
            required: ["id", "label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "string"
    }
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(opaqueMap, {
    sourceFile: "/test.tsx",
    position: { line: 49, col: 23 },
    bindingName: "opaqueMap"
});
export { comparable, opaqueMap, pushOnly, readOnly, readWrite, setOnly, updateOnly, };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_1
});
