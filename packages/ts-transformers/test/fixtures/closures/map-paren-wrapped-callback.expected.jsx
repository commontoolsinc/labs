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
import { pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Row {
    label: string;
}
const __cfPattern_1 = __cfHelpers.pattern(__cf_pattern_input => {
    const r = __cf_pattern_input.key("element");
    return r.key("label");
}, {
    type: "object",
    properties: {
        element: {
            $ref: "#/$defs/Row"
        }
    },
    required: ["element"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfPattern_1, {
    sourceFile: "/test.tsx",
    position: { line: 15, col: 24 },
    bindingName: "out"
});
// FIXTURE: map-paren-wrapped-callback
// Verifies: a parenthesized inline map callback lowers exactly like its bare
//   spelling — rows.map(((r) => r.label)) → rows.mapWithPattern(pattern(...))
// Context: paren-invariance (target spec §5.7) at the extraction seam; a blind
//   arguments[0] read here once skipped the lowering entirely, emitting a raw
//   reactive .map that throws at runtime
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const rows = __cf_pattern_input.key("rows");
    const out = rows.mapWithPattern(__cfPattern_1, {}).for("out", true);
    return { out };
}, {
    type: "object",
    properties: {
        rows: {
            type: "array",
            items: {
                $ref: "#/$defs/Row"
            }
        }
    },
    required: ["rows"],
    $defs: {
        Row: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        out: {
            type: "array",
            items: {
                type: "string"
            }
        }
    },
    required: ["out"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 40 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfPattern_1
});
