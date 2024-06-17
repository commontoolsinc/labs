import { view } from "../hyperscript/render.js";

export const p = view("p", {
  type: "object",
  properties: {
    id: { type: "string" },
  },
});
