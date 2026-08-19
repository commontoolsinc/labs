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
import { NAME, pattern, str } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface PatternState {
    value: number;
}
function format(n: number): string {
    return `#${n}`;
}
__cfHardenFn(format);
const __cfLift_1 = __cfHelpers.lift<{
    cell: {
        value: number;
    };
}, string>(({ cell }) => format(cell.value), {
    type: "object",
    properties: {
        cell: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 26, col: 42 }
});
const __cfLift_2 = __cfHelpers.lift<{
    cell: {
        value: number;
    };
}, number>(({ cell }) => cell.value + 1, {
    type: "object",
    properties: {
        cell: {
            type: "object",
            properties: {
                value: {
                    type: "number"
                }
            },
            required: ["value"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 27, col: 6 }
});
// FIXTURE: str-template-call-interpolation
// Verifies: reactive lowering of expressions interpolated into a str`` tagged template.
//   The str runtime lifts its interpolation over the values it receives, so any value
//   that is a bare reactive READ stays reactive (str re-reads the cell). But a value
//   produced by a COMPUTED expression (a call, a binary op) must be lifted per-span,
//   or it freezes at construction. This mirrors how JSX `{expr}` is handled.
//     ${cell.value}          → ${cell.key("value")}              (bare read, not lifted)
//     ${format(cell.value)}  → ${__cfHelpers.lift(...)(...)}      (call lifted)
//     ${cell.value + 1}      → ${__cfHelpers.lift(...)(...)}      (binary lifted)
// Context: Regression for CT-1621 — derive(cell.value, String) migrated to bare
//   String(cell.value) inside str`` silently dropped reactivity because interpolation
//   call-expressions were never classified as lowerable expression sites.
export default __cfBindVerifiedBinding(pattern((cell) => {
    return {
        [NAME]: str `bare ${cell.key("value")} call ${__cfLift_1({ cell: {
                value: cell.key("value")
            } })} math ${__cfLift_2({ cell: {
                value: cell.key("value")
            } })}`,
        value: cell.key("value"),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number"
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $NAME: {
            type: "string"
        },
        value: {
            type: "number"
        }
    },
    required: ["$NAME", "value"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 24, col: 37 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
