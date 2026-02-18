import * as __ctHelpers from "commontools";
import { handler } from "commontools";
// No type annotations at all - should generate unknown schemas
export const genericHandler = handler(true as const satisfies __ctHelpers.JSONSchema, true as const satisfies __ctHelpers.JSONSchema, (event, state) => {
    console.log("event:", event, "state:", state);
});
// @ts-ignore: Internals
function h(...args: any[]) { return __ctHelpers.h.apply(null, args); }
// @ts-ignore: Internals
h.fragment = __ctHelpers.h.fragment;
