import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const checkbox = view(
  "input",
  {
    ...eventProps(),
    id: { type: "string" },
    checked: { type: "boolean" },
    value: { type: "string" },
  },
  { type: "checkbox" }
);
