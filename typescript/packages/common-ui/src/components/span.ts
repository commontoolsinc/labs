import { view } from "../hyperscript/view.js";
import { register as registerView } from "../hyperscript/known-tags.js";

export const span = view("span", {
  type: "object",
  properties: {
    id: { type: "string" },
  },
});

registerView(span);
