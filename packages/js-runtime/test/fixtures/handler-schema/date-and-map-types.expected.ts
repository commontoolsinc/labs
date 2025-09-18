/// <cts-enable />
import { handler, JSONSchema } from "commontools";
interface TimedEvent {
    timestamp: Date;
    data: Map<string, number>;
}
interface TimedState {
    lastUpdate: Date;
    history: Map<string, Date>;
}
const timedHandler = handler({
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        timestamp: {
            type: "string",
            format: "date-time"
        },
        data: {
            $ref: "#/definitions/Map"
        }
    },
    required: ["timestamp", "data"],
    definitions: {
        Map: {
            type: "object",
            properties: {
                clear: {
                    type: "object",
                    properties: {}
                },
                delete: {
                    type: "object",
                    properties: {}
                },
                forEach: {
                    type: "object",
                    properties: {}
                },
                get: {
                    type: "object",
                    properties: {}
                },
                has: {
                    type: "object",
                    properties: {}
                },
                set: {
                    type: "object",
                    properties: {}
                },
                size: {
                    type: "number"
                },
                entries: {
                    type: "object",
                    properties: {}
                },
                keys: {
                    type: "object",
                    properties: {}
                },
                values: {
                    type: "object",
                    properties: {}
                }
            },
            required: ["clear", "delete", "forEach", "get", "has", "set", "size", "entries", "keys", "values"]
        }
    }
} as const satisfies JSONSchema, {
    $schema: "https://json-schema.org/draft-07/schema#",
    type: "object",
    properties: {
        lastUpdate: {
            type: "string",
            format: "date-time"
        },
        history: {
            $ref: "#/definitions/Map"
        }
    },
    required: ["lastUpdate", "history"],
    definitions: {
        Map: {
            type: "object",
            properties: {
                clear: {
                    type: "object",
                    properties: {}
                },
                delete: {
                    type: "object",
                    properties: {}
                },
                forEach: {
                    type: "object",
                    properties: {}
                },
                get: {
                    type: "object",
                    properties: {}
                },
                has: {
                    type: "object",
                    properties: {}
                },
                set: {
                    type: "object",
                    properties: {}
                },
                size: {
                    type: "number"
                },
                entries: {
                    type: "object",
                    properties: {}
                },
                keys: {
                    type: "object",
                    properties: {}
                },
                values: {
                    type: "object",
                    properties: {}
                }
            },
            required: ["clear", "delete", "forEach", "get", "has", "set", "size", "entries", "keys", "values"]
        }
    }
} as const satisfies JSONSchema, (event, state) => {
    state.lastUpdate = event.timestamp;
    event.data.forEach((value, key) => {
        state.history.set(key, new Date());
    });
});
export { timedHandler };
