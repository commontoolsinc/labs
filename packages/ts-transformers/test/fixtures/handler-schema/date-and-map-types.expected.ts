import * as __ctHelpers from "commontools";
import { handler } from "commontools";
interface TimedEvent {
    timestamp: Date;
    data: Map<string, number>;
}
interface TimedState {
    lastUpdate: Date;
    history: Map<string, Date>;
}
const timedHandler = handler({
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
} as const satisfies __ctHelpers.JSONSchema, {
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
} as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    state.lastUpdate = event.timestamp;
    event.data.forEach((_value, key) => {
        state.history.set(key, new Date());
    });
});
export { timedHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
