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
import { handler, Cell } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface CounterEvent {
    increment: number;
}
interface CounterState {
    value: Cell<number>;
}
const myHandler = handler({
    type: "object",
    properties: {
        increment: {
            type: "number"
        }
    },
    required: ["increment"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.value.set(state.value.get() + event.increment);
});
__cfBindVerifiedBinding(myHandler, {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 54 },
    bindingName: "myHandler"
});
// FIXTURE: simple-handler
// Verifies: basic handler type parameters are transformed into event and context JSON schemas
//   handler<CounterEvent, CounterState>(fn) → handler(eventSchema, contextSchema, fn)
//   Cell<number> → { type: "number", asCell: true }
export { myHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
