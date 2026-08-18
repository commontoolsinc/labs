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
import { Default, NAME, pattern, toSchema } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Input {
    selectedIndex: number | Default<number, -1>;
    threshold: number | Default<number, -0.5>;
}
const inputSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        selectedIndex: {
            type: "number",
            "default": -1
        },
        threshold: {
            type: "number",
            "default": -0.5
        }
    },
    required: ["selectedIndex", "threshold"]
} as const satisfies __cfHelpers.JSONSchema);
// FIXTURE: negative-number-default
// Verifies: negative numeric defaults are emitted as unary minus expressions
// (the TS factory rejects negative numbers in createNumericLiteral)
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const selectedIndex = __cf_pattern_input.key("selectedIndex");
    const threshold = __cf_pattern_input.key("threshold");
    return ({
        [NAME]: "Negative defaults",
        selectedIndex,
        threshold,
    });
}, {
    type: "object",
    properties: {
        selectedIndex: {
            type: "number",
            "default": -1
        },
        threshold: {
            type: "number",
            "default": -0.5
        }
    },
    required: ["selectedIndex", "threshold"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        selectedIndex: {
            type: "number"
        },
        threshold: {
            type: "number"
        }
    },
    required: ["$NAME", "selectedIndex", "threshold"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 15, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
