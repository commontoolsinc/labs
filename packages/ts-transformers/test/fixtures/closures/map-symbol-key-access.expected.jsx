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
import { NAME, UI, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Entry {
    [NAME]: string;
    [UI]: string;
}
interface Input {
    items: Entry[];
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const item = __cf_pattern_input.key("element");
    return ({ n: item.key(__cfHelpers.NAME), u: item.key(__cfHelpers.UI) });
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Entry"
        }
    },
    required: ["element"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                $NAME: {
                    type: "string"
                },
                $UI: {
                    type: "string"
                }
            },
            required: ["$NAME", "$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        n: {
            type: "string"
        },
        u: {
            type: "string"
        }
    },
    required: ["n", "u"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 19, col: 12 }
});
// FIXTURE: map-symbol-key-access
// Verifies: .map() on reactive array is transformed when callback uses symbol key access
//   .map(fn) → .mapWithPattern(pattern(...), {})
//   item[NAME] → item.key(__cfHelpers.NAME), item[UI] → item.key(__cfHelpers.UI)
// Context: Symbol-keyed property access (NAME, UI) is lowered to .key() with helper references
const _p = pattern((__cf_pattern_input) => {
    const items = __cf_pattern_input.key("items");
    return items.mapWithPattern(__cfPattern_1, {});
}, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Entry"
            }
        }
    },
    required: ["items"],
    $defs: {
        Entry: {
            type: "object",
            properties: {
                $NAME: {
                    type: "string"
                },
                $UI: {
                    type: "string"
                }
            },
            required: ["$NAME", "$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "array",
    items: {
        type: "object",
        properties: {
            n: {
                type: "string"
            },
            u: {
                type: "string"
            }
        },
        required: ["n", "u"]
    }
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(_p, {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 26 },
    bindingName: "_p"
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    _p,
    __cfPattern_1
});
