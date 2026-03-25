import * as __cfHelpers from "commonfabric";
import { handler, Cell } from "commonfabric";
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
} as const satisfies __cfHelpers.JSONSchema, {
    type: "object",
    properties: {
        lastUpdate: {
            type: "string",
            format: "date-time",
            asCell: true
        }
    },
    required: ["lastUpdate"]
} as const satisfies __cfHelpers.JSONSchema, (event, state) => {
    state.lastUpdate.set(event.timestamp);
});
// FIXTURE: date-types
// Verifies: Date type maps to JSON Schema string with format "date-time"
//   Date → { type: "string", format: "date-time" }
//   Cell<Date> → { type: "string", format: "date-time", asCell: true }
export { timedHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __cfHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __cfHelpers.h.fragment;
