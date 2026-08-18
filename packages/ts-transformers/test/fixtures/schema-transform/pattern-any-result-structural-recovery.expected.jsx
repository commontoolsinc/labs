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
declare function fetchAny(): any;
// FIXTURE: pattern-any-result-structural-recovery
// Verifies: inferred pattern results can still emit concrete object schemas when
// `any` only appears in nested properties.
//   pattern<Input>(fn) → pattern(fn, inputSchema, objectResultSchema)
// Context: the top-level result stays structural, but `title` degrades to `true`.
export default __cfBindVerifiedBinding(pattern((__cf_pattern_input) => {
    const prompt = __cf_pattern_input.key("prompt");
    return { title: fetchAny().title, prompt };
}, {
    type: "object",
    properties: {
        prompt: {
            type: "string"
        }
    },
    required: ["prompt"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        title: true,
        prompt: {
            type: "string"
        }
    },
    required: ["title", "prompt"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 11, col: 43 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
