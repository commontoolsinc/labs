/// <cts-enable />
import { handler, JSONSchema } from "commontools";
// No type annotations at all - should generate false schemas (unknown type)
export const genericHandler = handler(false as const satisfies JSONSchema, false as const satisfies JSONSchema, (event, state) => {
    console.log("event:", event, "state:", state);
});