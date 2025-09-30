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
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        timestamp: {
            type: "string",
            format: "date-time"
        },
        data: {
            $ref: "#/$defs/Map"
        }
    },
    required: ["timestamp", "data"],
    $defs: {
        Map: {
            type: "object",
            properties: {
                size: {
                    type: "number"
                }
            },
            required: ["size"]
        }
    }
} as const satisfies JSONSchema, {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    type: "object",
    properties: {
        lastUpdate: {
            type: "string",
            format: "date-time"
        },
        history: {
            $ref: "#/$defs/Map"
        }
    },
    required: ["lastUpdate", "history"],
    $defs: {
        Map: {
            type: "object",
            properties: {
                size: {
                    type: "number"
                }
            },
            required: ["size"]
        }
    }
} as const satisfies JSONSchema, (event, state) => {
    state.lastUpdate = event.timestamp;
    event.data.forEach((value, key) => {
        state.history.set(key, new Date());
    });
});
export { timedHandler };
