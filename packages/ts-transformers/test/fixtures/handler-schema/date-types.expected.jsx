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
interface TimedEvent {
    timestamp: Date;
}
interface TimedState {
    lastUpdate: Cell<Date>;
}
const timedHandler = handler({
    type: "object",
    properties: {
        timestamp: {
            type: "object"
        }
    },
    required: ["timestamp"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        lastUpdate: {
            type: "object",
            asCell: ["writeonly"]
        }
    },
    required: ["lastUpdate"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.lastUpdate.set(event.timestamp);
});
__cfBindVerifiedBinding(timedHandler, {
    sourceFile: "/test.tsx",
    position: { line: 12, col: 53 },
    bindingName: "timedHandler"
});
// FIXTURE: date-types
// Verifies: Date type maps to JSON Schema string with format "date-time"
//   Date → { type: "string", format: "date-time" }
//   Cell<Date> → { type: "string", format: "date-time", asCell: true }
export { timedHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
