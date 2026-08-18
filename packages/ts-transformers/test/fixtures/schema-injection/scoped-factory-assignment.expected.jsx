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
import { pattern, type PerSession, type PerUser } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
type ChildInput = {
    label: string;
};
type ChildOutput = {
    label: string;
};
const Child = pattern((__cf_pattern_input) => {
    const label = __cf_pattern_input.key("label");
    return ({ label });
}, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(Child, {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 47 },
    bindingName: "Child"
});
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const label = __cf_pattern_input.key("label");
    const userChild: PerUser<ChildOutput> = Child.asScope("user")({ label });
    const sessionChild: PerSession<ChildOutput> = Child.asScope("session")({ label });
    const plainChild: ChildOutput = Child({ label });
    return {
        userChild,
        sessionChild,
        plainChild,
    };
}, {
    type: "object",
    properties: {
        label: {
            type: "string"
        }
    },
    required: ["label"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        userChild: {
            $ref: "#/$defs/ChildOutput",
            scope: "user"
        },
        sessionChild: {
            $ref: "#/$defs/ChildOutput",
            scope: "session"
        },
        plainChild: {
            $ref: "#/$defs/ChildOutput"
        }
    },
    required: ["userChild", "sessionChild", "plainChild"],
    $defs: {
        ChildOutput: {
            type: "object",
            properties: {
                label: {
                    type: "string"
                }
            },
            required: ["label"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 14, col: 35 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    Child
});
