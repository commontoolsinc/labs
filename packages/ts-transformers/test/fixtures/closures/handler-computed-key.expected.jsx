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
import { Cell, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface State {
    records: Record<string, Cell<number>>;
}
let counter = 0;
function nextKey(): string {
    counter += 1;
    return `key-${counter}`;
}
__cfHardenFn(nextKey);
const __cfHandler_1 = __cfHelpers.handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        recordMap: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number",
                asCell: ["cell"]
            }
        }
    },
    required: ["recordMap"]
} as const satisfies __cfHelpers.JSONSchema, (__cf_handler_event, { recordMap }) => recordMap[nextKey()]!.set(counter));
__cfBindVerifiedBinding(__cfHandler_1, {
    sourceFile: "/test.tsx",
    position: { line: 22, col: 37 }
});
// FIXTURE: handler-computed-key
// Verifies: handler capturing a Record with computed (dynamic) key access is transformed correctly
//   onClick={() => recordMap[nextKey()]!.set(counter)) → handler(false, { recordMap: { additionalProperties, asOpaque } }, ...)({ recordMap })
// Context: Dynamic property access via computed key; Record type uses additionalProperties in schema
export default __cfBindVerifiedBinding(pattern((state) => {
    const recordMap = state.key("records");
    return {
        [UI]: (<button type="button" onClick={__cfHandler_1({
            recordMap: recordMap
        })}>
        Step
      </button>),
    };
}, {
    type: "object",
    properties: {
        records: {
            type: "object",
            properties: {},
            additionalProperties: {
                type: "number",
                asCell: ["cell"]
            }
        }
    },
    required: ["records"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        $UI: {
            $ref: "#/$defs/JSXElement"
        }
    },
    required: ["$UI"],
    $defs: {
        JSXElement: {
            anyOf: [{
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }, {
                    $ref: "#/$defs/UIRenderable"
                }, {
                    type: "object",
                    properties: {}
                }]
        },
        UIRenderable: {
            type: "object",
            properties: {
                $UI: {
                    $ref: "https://commonfabric.org/schemas/vnode.json"
                }
            },
            required: ["$UI"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 18, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    __cfHandler_1
});
