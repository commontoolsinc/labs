import { view } from "../hyperscript/view.js";
import { register as registerView } from "../hyperscript/known-tags.js";

export const p = view("p", {
  type: "object",
  properties: {
    id: { type: "string" },
  },
});

registerView(p);
