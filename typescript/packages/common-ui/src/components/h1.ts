import { view } from "../hyperscript/view.js";
import { register as registerView } from "../hyperscript/known-tags.js";

export const h1 = view("h1", {
  type: "object",
  properties: {
    id: { type: "string" },
  },
});

registerView(h1);
