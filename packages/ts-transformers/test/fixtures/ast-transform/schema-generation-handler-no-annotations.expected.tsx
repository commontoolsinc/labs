/// <cts-enable />
import { handler, JSONSchema } from "commontools";
// No type annotations at all - should generate unknown schemas
export const genericHandler = handler({} as const satisfies JSONSchema, {} as const satisfies JSONSchema, (event, state) => {
    console.log("event:", event, "state:", state);
});