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
import { computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    token: string;
}, string>(({ token }) => `http://api.example.com?token=${token}`, {
    type: "object",
    properties: {
        token: {
            type: "string"
        }
    },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "string"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 9, col: 23 },
    bindingName: "url"
});
const __cfLift_2 = __cfHelpers.lift<{
    token: string;
}, { headers: { Authorization: string; }; }>(({ token }) => ({
    headers: { Authorization: `Bearer ${token}` },
}), {
    type: "object",
    properties: {
        token: {
            type: "string"
        }
    },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        headers: {
            type: "object",
            properties: {
                Authorization: {
                    type: "string"
                }
            },
            required: ["Authorization"]
        }
    },
    required: ["headers"]
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_2, {
    sourceFile: "/test.tsx",
    position: { line: 10, col: 27 },
    bindingName: "options"
});
// CT-1334: computed() with template literal capturing pattern parameter.
// The `token` from pattern destructuring must be captured as an explicit
// input to the lift-applied call, so the callback receives the
// resolved value—not the Reactive proxy.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input: {
    token: string;
}) => {
    const token = __cf_pattern_input.key("token");
    const url = __cfLift_1({ token: token }).for("url", true);
    const options = __cfLift_2({ token: token }).for("options", true);
    return { url, options };
}, {
    type: "object",
    properties: {
        token: {
            type: "string"
        }
    },
    required: ["token"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        url: {
            type: "string"
        },
        options: {
            type: "object",
            properties: {
                headers: {
                    type: "object",
                    properties: {
                        Authorization: {
                            type: "string"
                        }
                    },
                    required: ["Authorization"]
                }
            },
            required: ["headers"]
        }
    },
    required: ["url", "options"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 8, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1,
    __cfLift_2
});
