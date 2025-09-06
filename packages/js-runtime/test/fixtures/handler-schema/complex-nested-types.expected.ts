/// <cts-enable />
import { handler, Cell, recipe, JSONSchema } from "commontools";
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
            enum: ["create", "update", "delete"]
        }
    },
    required: ["user", "action"]
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
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
            asCell: true
        },
        lastAction: {
            type: "string",
            asCell: true
        },
        count: {
            type: "number",
            asCell: true
        }
    },
    required: ["users", "lastAction", "count"]
} as const satisfies JSONSchema, (event, state) => {
    if (event.action === "create") {
        state.users.push({
            id: Date.now().toString(),
            name: event.user.name,
            email: event.user.email
        });
        state.count.set(state.count.get() + 1);
    }
    state.lastAction.set(event.action);
});
const updateTags = handler({
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
} as const satisfies JSONSchema, {
    type: "object",
    properties: {
        tags: {
            type: "array",
            items: {
                type: "string"
            },
            asCell: true
        }
    },
    required: ["tags"]
} as const satisfies JSONSchema, ({ detail }, state) => {
    state.tags.set(detail?.tags ?? []);
});
export { userHandler };
export default recipe("complex-nested-types test", () => {
    return { userHandler };
});

