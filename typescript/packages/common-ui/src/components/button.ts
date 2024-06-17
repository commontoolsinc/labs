import { view } from "../hyperscript/render.js";

export const button = view("button", {
  type: "object",
  properties: {
    id: { type: "string" },
    "@click": {
      type: "object",
      properties: { "@type": { type: "string" }, name: { type: "string" } },
    },
  },
});
