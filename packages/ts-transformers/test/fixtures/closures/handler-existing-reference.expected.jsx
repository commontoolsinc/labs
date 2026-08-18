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
import { handler, pattern, UI } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
declare global {
    namespace JSX {
        interface IntrinsicElements {
            "cf-button": any;
        }
    }
}
interface State {
    count: number;
}
const existing = handler(false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        state: {
            $ref: "#/$defs/State"
        }
    },
    required: ["state"],
    $defs: {
        State: {
            type: "object",
            properties: {
                count: {
                    type: "number"
                }
            },
            required: ["count"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_event, { state }: {
    state: State;
}) => {
    console.log(state.count);
});
__cfBindVerifiedBinding(existing, {
    sourceFile: "/test.tsx",
    position: { line: 16, col: 25 },
    bindingName: "existing"
});
// FIXTURE: handler-existing-reference
// Verifies: pre-declared handler() call site is NOT re-wrapped; only its schema is generated
//   existing({ state }) → existing({ state }) (call site unchanged)
//   handler(fn) at declaration → handler(false, captureSchema, fn) (schema injected at definition)
// Context: handler() declared outside the pattern; the transform adds schemas but does not re-extract
export default __cfBindVerifiedBinding(pattern((state) => {
    return {
        [UI]: (<cf-button onClick={existing({ state })}>
        Existing
      </cf-button>),
    };
}, {
    type: "object",
    properties: {
        count: {
            type: "number"
        }
    },
    required: ["count"]
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
    position: { line: 25, col: 30 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    existing
});
