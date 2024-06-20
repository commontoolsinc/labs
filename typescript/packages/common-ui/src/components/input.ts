import { view } from "../hyperscript/render.js";
import { Props } from "../hyperscript/view.js";
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

export const textInput = (props: Props) => input({ ...props, type: "text" });
export const checkbox = (props: Props) => input({ ...props, type: "checkbox" });
export const radio = (props: Props) => input({ ...props, type: "radio" });
export const fileInput = (props: Props) => input({ ...props, type: "file" });
export const imageInput = (props: Props) => input({ ...props, type: "image" });
export const password = (props: Props) => input({ ...props, type: "password" });
export const searchInput = (props: Props) =>
  input({ ...props, type: "search" });