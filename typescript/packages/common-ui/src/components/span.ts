import { view } from "../hyperscript/render.js";

export const span = view("span", {
  type: "object",
  properties: {
    id: { type: "string" },
  },
});
