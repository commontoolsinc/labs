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
import { Cell, handler } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
interface Item {
    text: string;
}
interface ListState {
    items: Cell<Item[]>;
}
const removeItem = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length)
        next.splice(index, 1);
    items.set(next);
});
__cfBindVerifiedBinding(removeItem, {
    sourceFile: "/test.tsx",
    position: { line: 13, col: 2 },
    bindingName: "removeItem"
});
// alias-based intersection variant
type ListStateWithIndex = ListState & {
    index: number;
};
const removeItemAlias = handler({
    type: "unknown"
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        items: {
            type: "array",
            items: {
                $ref: "#/$defs/Item"
            },
            asCell: ["cell"]
        },
        index: {
            type: "number"
        }
    },
    required: ["items", "index"],
    $defs: {
        Item: {
            type: "object",
            properties: {
                text: {
                    type: "string"
                }
            },
            required: ["text"]
        }
    }
} as const satisfies __cfHelpers.JSONSchema, (_, { items, index }) => {
    const next = items.get().slice();
    if (index >= 0 && index < next.length)
        next.splice(index, 1);
    items.set(next);
});
__cfBindVerifiedBinding(removeItemAlias, {
    sourceFile: "/test.tsx",
    position: { line: 23, col: 2 },
    bindingName: "removeItemAlias"
});
// FIXTURE: array-cell-remove-intersection
// Verifies: handler context intersection types are flattened and Cell<T[]> generates array schema with asCell
//   handler<unknown, ListState & { index: number }>() → event: true, context: merged {items, index} schema
//   Cell<Item[]> → { type: "array", items: { $ref: ... }, asCell: true }
// Context: inline intersection vs type alias intersection; alias variant loses $defs (items: true)
export { removeItem, removeItemAlias };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
