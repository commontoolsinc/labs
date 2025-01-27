import { h } from "@commontools/html";
import { recipe, UI, NAME } from "@commontools/builder";
import type { JSONSchema } from "@commontools/builder";

// @ts-ignore this loads the html file using VITE.js as a string from the html file on disk
import src from "./smolIframe.html?raw";

const jsonSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      default: 0
    },
  },
  description: "SMOL Counter demo"
} as JSONSchema;


export default recipe(jsonSchema, (data) => {
  return {
    type: "iframe",
    [NAME]: "smol iframe",
    [UI]: (
      <common-iframe src={src} $context={data}></common-iframe>
    ),
  };
});
