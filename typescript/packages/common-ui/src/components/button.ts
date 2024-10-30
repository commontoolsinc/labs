import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const button = view("button", {
  ...eventProps(),
  id: { type: "string" },
});
