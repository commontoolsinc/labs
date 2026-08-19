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
import { Cell, pattern, toSchema, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    value: Cell<number>;
}
const model = __cfHelpers.__cf_data({
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"],
    "default": {
        value: 0
    }
} as const satisfies __cfHelpers.JSONSchema);
const __cfLift_1 = __cfHelpers.lift<{
    cell: {
        value: __cfHelpers.Cell<number>;
    };
}, number>(({ cell }) => cell.value.get() * 2, {
    type: "object",
    properties: {
        cell: {
            type: "object",
            properties: {
                value: {
                    type: "number",
                    asCell: ["readonly"]
                }
            },
            required: ["value"]
        }
    },
    required: ["cell"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "number"
} as const satisfies __cfHelpers.JSONSchema);
__cfBindVerifiedBinding(__cfLift_1, {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 18 },
    bindingName: "doubled"
});
// FIXTURE: with-reactive
// Verifies: Cell<> fields generate asCell in schema and a reactive builder gets input/output schemas injected
//   Cell<number> → { type: "number", asCell: true }
//   toSchema<State>({default: ...}) → schema with "default" key preserved
//   bare `cell.value.get() * 2` → auto-wraps, capturing cell.key("value") into lift(inputSchema, outputSchema, fn)
export default __cfBindVerifiedBinding(pattern((cell) => {
    const doubled = __cfLift_1({ cell: {
            value: cell.key("value")
        } }).for("doubled", true);
    return {
        [UI]: (<div>
        <p>Value: {cell.key("value")}</p>
        <p>Doubled: {doubled}</p>
      </div>),
        value: cell.key("value"),
    };
}, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        value: {
            type: "number",
            asCell: ["cell"]
        }
    },
    required: ["value"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 17, col: 37 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfLift_1
});
