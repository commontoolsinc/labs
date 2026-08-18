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
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface IncrementEvent {
    amount: number;
}
// FIXTURE: schema-generation-handler-event-only
// Verifies: handler() with only event param typed generates event schema and false for state
//   handler((event: IncrementEvent, _state) => ...) → handler(eventSchema, false, fn)
// Context: Untyped state param gets `false` as its schema (unknown)
// Only event is typed, state should get unknown schema
export const incrementer = __cfBindVerifiedBinding(handler({
    type: "object",
    properties: {
        amount: {
            type: "number"
        }
    },
    required: ["amount"]
} as const satisfies __cfHelpers.JSONSchema, false as const satisfies __cfHelpers.JSONSchema, (event: IncrementEvent, _state) => {
    console.log("increment by", event.amount);
}), {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 35 },
    bindingName: "incrementer"
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
