import { h } from "@commontools/html";
import { recipe, UI, NAME } from "@commontools/builder";
import type { JSONSchema } from "@commontools/builder";

type Recipe = {
  type: "iframe",
  src: string,
  argumentSchema: JSONSchema,
  resultSchema: JSONSchema,
  spec: string,
  name: string,
}

// @ts-ignore this loads the html file using VITE.js as a string from the html file on disk
import src from "./smolIframe.html?raw";
const argumentSchema = {
  type: "object",
  properties: {
    count: {
      type: "number",
      default: 0
    },
  },
  description: "SMOL Counter demo"
} as JSONSchema;

const resultSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      default: "(empty)"
    },
  },
  description: "SMOL Counter demo"
} as JSONSchema;

const spec = "emoji style counter that increments by 1 when clicked"

const iframeRecipe: Recipe = {
  type: "iframe",
  src,
  argumentSchema,
  resultSchema,
  spec,
  name: "smol iframe",
}

const runIframeRecipe = ({argumentSchema, resultSchema, src, name}: Recipe) => 
  recipe(argumentSchema, resultSchema, (data) => ({
    [NAME]: name,
    [UI]: (
      <common-iframe src={src} $context={data}></common-iframe>
    ),
    // FIXME: add resultSchema to the result
  }));

export default runIframeRecipe(iframeRecipe);
