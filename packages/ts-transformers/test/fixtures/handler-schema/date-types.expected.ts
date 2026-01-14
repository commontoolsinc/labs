import * as __ctHelpers from "commontools";
import { handler, Cell } from "commontools";
interface TimedEvent {
    timestamp: Date;
}
interface TimedState {
    lastUpdate: Cell<Date>;
}
const timedHandler = handler({
    type: "object",
    properties: {
        timestamp: {
            type: "string",
            format: "date-time"
        }
    },
    required: ["timestamp"]
} as const satisfies __ctHelpers.JSONSchema, {
    type: "object",
    properties: {
        lastUpdate: {
            type: "string",
            format: "date-time",
            asCell: true
        }
    },
    required: ["lastUpdate"]
} as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    state.lastUpdate.set(event.timestamp);
});
export { timedHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
