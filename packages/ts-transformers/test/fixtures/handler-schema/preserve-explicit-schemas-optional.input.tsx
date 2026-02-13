/// <cts-enable />
import { handler } from "commontools";
import "commontools/schema";

// Schema without required fields - properties are optional
const eventSchema = {
  type: "object",
  properties: {
    message: { type: "string" },
  },
} as const;

const stateSchema = {
  type: "object",
  properties: {
    log: { type: "array", items: { type: "string" } },
  },
} as const;

// Handler defensively handles optional properties
const logHandler = handler(eventSchema, stateSchema, (event, state) => {
  // Use optional chaining and nullish coalescing since properties may be undefined
  state.log?.push(event.message ?? "no message");
});

export { logHandler };
