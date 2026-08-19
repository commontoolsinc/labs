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
import { handler } from "commonfabric";
import "commonfabric/schema";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// Schema without required fields - properties are optional
const eventSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        message: { type: "string" },
    },
} as const);
const stateSchema = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        log: { type: "array", items: { type: "string" } },
    },
} as const);
const logHandler = handler(eventSchema, stateSchema, (event, state) => {
    // Use optional chaining and nullish coalescing since properties may be undefined
    state.log?.push(event.message ?? "no message");
});
__cfBindVerifiedBinding(logHandler, {
    sourceFile: "/test.tsx",
    position: { line: 20, col: 53 },
    bindingName: "logHandler"
});
// FIXTURE: preserve-explicit-schemas-optional
// Verifies: explicit schemas without "required" arrays are preserved as-is (optional properties)
//   handler(eventSchema, stateSchema, fn) → handler(eventSchema, stateSchema, fn) (no transformation)
// Context: schemas omit "required" making all properties optional; transformer must not add required
export { logHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
