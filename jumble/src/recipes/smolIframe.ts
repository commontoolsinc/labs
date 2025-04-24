import { h } from "@commontools/html";
import { JSONSchema, NAME, recipe, UI } from "@commontools/builder";

import src from "./smolIFrame.html?raw";

const argumentSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      default: 0,
    },
  },
  description: "SMOL Counter demo",
} satisfies JSONSchema;

export default recipe(argumentSchema, (data) => ({
  [NAME]: "smol iframe",
  [UI]: h("common-iframe", { src, $context: data }),
}));
