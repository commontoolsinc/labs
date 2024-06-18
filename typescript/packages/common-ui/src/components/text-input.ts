import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const textInput = view(
  "input",
  {
    ...eventProps(),
    id: { type: "string" },
    value: { type: "string" },
    placeholder: { type: "string" },
  },
  { type: "text" }
);
