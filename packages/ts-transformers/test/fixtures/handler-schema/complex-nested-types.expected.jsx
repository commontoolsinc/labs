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
import { Cell, handler, pattern } from "commonfabric";
const define = undefined;
const runtimeDeps = undefined;
const __cfAmdHooks = undefined;
// Updated 2025-09-03: String literal unions now generate correct JSON Schema
// (enum instead of array) due to schema-generator UnionFormatter improvements
interface UserEvent {
    user: {
        name: string;
        email: string;
        age?: number;
    };
    action: "create" | "update" | "delete";
}
interface UserState {
    users: Cell<Array<{
        id: string;
        name: string;
        email: string;
    }>>;
    lastAction: Cell<string>;
    count: Cell<number>;
}
const userHandler = handler({
    type: "object",
    properties: {
        user: {
            type: "object",
            properties: {
                name: {
                    type: "string"
                },
                email: {
                    type: "string"
                },
                age: {
                    type: "number"
                }
            },
            required: ["name", "email"]
        },
        action: {
            "enum": ["create", "update", "delete"]
        }
    },
    required: ["user", "action"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        count: {
            type: "number",
            asCell: ["cell"]
        },
        users: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    id: {
                        type: "string"
                    },
                    name: {
                        type: "string"
                    },
                    email: {
                        type: "string"
                    }
                },
                required: ["id", "name", "email"]
            },
            asCell: ["writeonly"]
        },
        lastAction: {
            type: "string",
            asCell: ["writeonly"]
        }
    },
    required: ["count", "users", "lastAction"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    if (event.action === "create") {
        state.users.push({
            id: Date.now().toString(),
            name: event.user.name,
            email: event.user.email,
        });
        state.count.set(state.count.get() + 1);
    }
    state.lastAction.set(event.action);
});
__cfBindVerifiedBinding(userHandler, {
    sourceFile: "/test.tsx",
    position: { line: 27, col: 50 },
    bindingName: "userHandler"
});
const _updateTags = handler({
    type: "object",
    properties: {
        detail: {
            type: "object",
            properties: {
                tags: {
                    type: "array",
                    items: {
                        type: "string"
                    }
                }
            },
            required: ["tags"]
        }
    },
    required: ["detail"]
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        tags: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: ["writeonly"]
        }
    },
    required: ["tags"]
} as const satisfies __cfHelpers.JSONSchema, ({ detail }, state) => {
    state.tags.set(detail?.tags ?? []);
});
__cfBindVerifiedBinding(_updateTags, {
    sourceFile: "/test.tsx",
    position: { line: 43, col: 2 },
    bindingName: "_updateTags"
});
export { userHandler };
// FIXTURE: complex-nested-types
// Verifies: handler with nested object types, string literal unions, and Cell-wrapped arrays generate correct schemas
//   handler<UserEvent, UserState>() → event schema with nested user object and action enum, context schema with asCell fields
//   "create" | "update" | "delete" → { enum: ["create", "update", "delete"] }
//   Cell<Array<{...}>> → { type: "array", items: { type: "object", ... }, asCell: true }
// Context: also tests a second handler (_updateTags) with Cell<string[]>; pattern wraps handler as asStream output
export default __cfBindVerifiedBinding(pattern(() => {
    return { userHandler };
}, false as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        userHandler: {
            asCell: ["stream"]
        }
    },
    required: ["userHandler"]
} as const satisfies __cfHelpers.JSONSchema), {
    sourceFile: "/test.tsx",
    position: { line: 56, col: 23 }
});
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
__cfHardenFn(h);
__cfReg({
    _updateTags
});
