import { h } from "@commontools/html";
import { recipe, UI, NAME, JSONSchema } from "@commontools/builder";

import src from "./smolIframe.html?raw";

const argumentSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      default: 0,
    },
  },
  description: "SMOL Counter demo",
} as JSONSchema;

export default recipe(argumentSchema, (data) => ({
  [NAME]: "smol iframe",
  [UI]: h("common-iframe", { src, $context: data }),
}));
