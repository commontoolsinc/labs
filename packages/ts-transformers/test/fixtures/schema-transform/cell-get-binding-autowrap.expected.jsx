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
import { pattern, Writable } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
const __cfLift_1 = __cfHelpers.lift<{
    layout: __cfHelpers.Writable<string>;
}, number>(({ layout }) => layout.get().trim().length, {
    type: "object",
    properties: {
        layout: {
            type: "string",
            asCell: ["readonly"]
        }
    },
    required: ["layout"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 14 },
    bindingName: "len"
});
// FIXTURE: cell-get-binding-autowrap
// Verifies: a `cell.get()` that feeds a chained computation at a
//   variable-initializer binding is auto-wrapped into a lift, the same way it is
//   in a JSX expression. A read with no lowerable container site at all — a bare
//   `cell.get();` statement — is still rejected with `pattern-context:get-call`.
// Context: lets an author drop a `computed()` wrapper and write the plain
//   expression even when the input is a Writable/Cell. The terminal-read
//   spellings of the same binding are covered by
//   `cell-get-terminal-binding-autowrap`.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const layout = __cf_pattern_input.key("layout");
    const len = __cfLift_1({ layout: layout }).for("len", true);
    return { len };
}, {
    type: "object",
    properties: {
        layout: {
            type: "string",
            asCell: ["cell"]
        }
    },
    required: ["layout"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        len: {
            type: "number"
        }
    },
    required: ["len"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 15, col: 3 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
