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
import { Writable, computed, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Point {
    x: number;
    y: number;
}
const __cfLift_1 = __cfHelpers.lift<{
    point: __cfHelpers.ReadonlyCell<Point>;
    multiplier: __cfHelpers.ReadonlyCell<number>;
}, number>(({ point, multiplier }) => {
    const { x, y } = point.get();
    return (x + y) * multiplier.get();
}, {
    type: "object",
    properties: {
        point: {
            $ref: "#/$defs/Point",
            asCell: ["readonly"]
        },
        multiplier: {
            type: "number",
            asCell: ["readonly"]
        }
    },
    required: ["point", "multiplier"],
    $defs: {
        Point: {
            type: "object",
            properties: {
                x: {
                    type: "number"
                },
                y: {
                    type: "number"
                }
            },
            required: ["x", "y"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema, { completeSchedulerScopeSummary: true });
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 26 },
    bindingName: "result"
});
// FIXTURE: computed-destructured-param
// Verifies: a captured cell works alongside destructuring inside the computed body
//   computed(() => { const { x, y } = point.get(); ... }) → lift(...)({ point, multiplier })
// Context: `const { x, y } = point.get()` destructures inside the body, not a parameter
export default __cfBindVerifiedBinding(pattern(() => {
    const point = new Writable({ x: 10, y: 20 } as Point, {
        type: "object",
        properties: {
            x: {
                type: "number"
            },
            y: {
                type: "number"
            }
        },
        required: ["x", "y"]
    } as const satisfies __cfHelpers.JSONSchema).for("point", true);
    const multiplier = new Writable(2, {
        type: "number"
    } as const satisfies __cfHelpers.JSONSchema).for("multiplier", true);
    // Destructuring requires .get() first since the captured cell is not unwrapped
    const result = __cfLift_1({
        point: point,
        multiplier: multiplier
    }).for("result", true);
    return result;
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
