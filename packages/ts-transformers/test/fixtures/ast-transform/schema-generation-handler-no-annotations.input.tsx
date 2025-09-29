/// <cts-enable />
import { handler } from "commontools";

// No type annotations at all - should generate unknown schemas
export const genericHandler = handler((event, state) => {
  console.log("event:", event, "state:", state);
});