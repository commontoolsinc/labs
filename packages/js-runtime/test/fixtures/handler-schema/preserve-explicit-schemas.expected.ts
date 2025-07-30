/// <cts-enable />
import { handler } from "commontools";
const eventSchema = {
    type: "object",
    properties: {
        message: { type: "string" }
    }
};
const stateSchema = {
    type: "object",
    properties: {
        log: { type: "array", items: { type: "string" } }
    }
};
const logHandler = handler(eventSchema, stateSchema, (event, state) => {
    state.log.push(event.message);
});
export { logHandler };