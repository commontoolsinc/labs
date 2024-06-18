import { view } from "../hyperscript/render.js";
import { eventProps } from "../hyperscript/schema-helpers.js";

export const input = view("input", {
  ...eventProps(),
  id: { type: "string" },
  alt: { type: "string" },
  name: { type: "string" },
  value: { type: "string" },
  type: { type: "string" },
  checked: { type: "boolean" },
  min: { type: "string" },
  minlength: { type: "number" },
  max: { type: "string" },
  maxlength: { type: "number" },
  pattern: { type: "string" },
  accept: { type: "string" },
  size: { type: "number" },
  placeholder: { type: "string" },
});
