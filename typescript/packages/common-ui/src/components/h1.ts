import { view } from "../hyperscript/render.js";

export const h1 = view("h1", {
  type: "object",
  properties: {
    id: { type: "string" },
  },
});
