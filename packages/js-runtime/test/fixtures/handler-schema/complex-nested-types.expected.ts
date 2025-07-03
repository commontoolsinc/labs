/// <cts-enable />
import { handler, Cell, toSchema, JSONSchema } from "commontools";
interface UserEvent {
    user: {
        name: string;
        email: string;
        age?: number;
    };
    action: "create" | "update" | "delete";
}
interface UserState {
    users: Array<{
        id: string;
        name: string;
        email: string;
    }>;
    lastAction: string;
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
            oneOf: [{
                    type: "any"
                }, {
                    type: "any"
                }, {
                    type: "any"
                }]
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
            }
        },
        lastAction: {
            type: "string"
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
    state.lastAction = event.action;
});
export { userHandler };