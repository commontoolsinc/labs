import { h } from "@commontools/html";
import { recipe, UI, NAME } from "@commontools/builder";
import type { JSONSchema } from "@commontools/builder";

//<TYPE>IFRAME V0</TYPE>

type Recipe = {
  type: "iframe";
  src: string;
  argumentSchema: JSONSchema;
  resultSchema: JSONSchema;
  spec: string;
  name: string;
};

//<SRC>
// const src = "<p>hello world</p>";\
import src from "./articlesIframe.html?raw";
//</SRC>

//<ARGUMENT SCHEMA>
const argumentSchema = {
  type: "object",
  properties: {
    articles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: {
            type: "string",
          },
          url: {
            type: "string",
          },
        },
        required: ["title", "url"],
      },
    },
  },
  description: "List of articles with titles and URLs",
} as JSONSchema;
//</ARGUMENT SCHEMA>

//<RESULT SCHEMA>
const resultSchema = {
  type: "object",
  properties: {
    text: {
      type: "string",
      default: "(empty)",
    },
  },
  description: "SMOL Counter demo",
} as JSONSchema;
//</RESULT SCHEMA>

//<SPEC>
const spec = "grid of articles";
//</SPEC>

//<NAME>
const name = "smol iframe";
//</NAME>

const iframeRecipe: Recipe = {
  type: "iframe",
  src,
  argumentSchema,
  resultSchema,
  spec,
  name,
};

const runIframeRecipe = ({ argumentSchema, resultSchema, src, name }: Recipe) =>
  recipe(argumentSchema, resultSchema, (data) => ({
    [NAME]: name,
    [UI]: <common-iframe src={src} $context={data}></common-iframe>,
    // FIXME: add resultSchema to the result
  }));

export default runIframeRecipe(iframeRecipe);
