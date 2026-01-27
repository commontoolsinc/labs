import * as __ctHelpers from "commontools";
import { handler } from "commontools";
import "commontools/schema";
const eventSchema = {
    type: "object",
    properties: {
        message: { type: "string" },
    },
    required: ["message"],
} as const;
const stateSchema = {
    type: "object",
    properties: {
        log: { type: "array", items: { type: "string" } },
    },
    required: ["log"],
} as const;
const logHandler = handler(eventSchema, stateSchema, (event, state) => {
    state.log.push(event.message);
});
export { logHandler };
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
