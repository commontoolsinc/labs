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
import { Cell, computed, lift, pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const liftSummary = lift(({ primary, secondary }) => {
    const primaryValue = primary.get();
    const secondaryValue = secondary.get();
    return {
        primary: primaryValue,
        secondary: secondaryValue,
        difference: primaryValue - secondaryValue,
    };
}, {
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: ["readonly"]
        },
        secondary: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        primary: {
            type: "number"
        },
        secondary: {
            type: "number"
        },
        difference: {
            type: "number"
        }
    },
    required: ["primary", "secondary", "difference"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(liftSummary, {
    sourceFile: "/test.tsx",
    position: { line: 6, col: 2 },
    bindingName: "liftSummary"
});
const __cfLift_1 = __cfHelpers.lift<{
    summary: {
        difference: any;
    };
}, any>(({ summary }) => summary.difference, {
    type: "object",
    properties: {
        summary: {
            type: "object",
            properties: {
                difference: true
            },
            required: ["difference"]
        }
    },
    required: ["summary"]
} as const satisfies __cfHelpers.JSONSchema, true as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 25, col: 32 },
    bindingName: "difference"
});
// FIXTURE: context-lift-result-property-projection
// Verifies: a reactive builder preserves projected property schemas when the captured
// input comes from a typed lift() result rather than falling back to unknown
//   computed(() => summary.difference) → captures { difference: number } and outputs number
//   (KEEP computed: baring to `summary.difference` lowers to a plain .key() access with NO
//    captured-input schema, defeating this fixture's projection-shrink coverage — verified)
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const primary = __cf_pattern_input.key("primary");
    const secondary = __cf_pattern_input.key("secondary");
    const summary = liftSummary({ primary: primary.for(["summary", "primary"], true), secondary: secondary.for(["summary", "secondary"], true) }).for("summary", true);
    const difference = __cfLift_1({ summary: {
            difference: summary.key("difference")
        } }).for("difference", true);
    return {
        summary,
        difference,
    };
}, {
    type: "object",
    properties: {
        primary: {
            type: "number",
            asCell: ["cell"]
        },
        secondary: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["primary", "secondary"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        summary: true,
        difference: true
    },
    required: ["summary", "difference"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 23, col: 2 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    liftSummary,
    __cfLift_1
});
