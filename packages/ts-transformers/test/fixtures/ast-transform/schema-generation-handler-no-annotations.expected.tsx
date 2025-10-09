import * as __ctHelpers from "commontools";
import { handler } from "commontools";
// No type annotations at all - should generate unknown schemas
export const genericHandler = handler(true as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    console.log("event:", event, "state:", state);
});
__ctHelpers.NAME; // <internals>
