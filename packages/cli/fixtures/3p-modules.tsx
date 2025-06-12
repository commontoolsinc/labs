import {
  derive,
  h,
  ID,
  type JSONSchema,
  NAME,
  recipe,
  str,
  UI,
} from "commontools";
import { DOMParser, type Element } from "dom-parser";
import TurndownService from "turndown";

const Input = {
  type: "object",
  properties: {
    foo: {
      type: "string",
    },
  },
  required: ["foo"],
  description: "input",
} as const satisfies JSONSchema;

const Output = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "string",
      },
    },
  },
} as const satisfies JSONSchema;

function assert(condition: boolean, message: string) {
  if (!condition) {
    throw new Error(message);
  }
}
export default recipe(
  Input,
  Output,
  (state) => {
    //const { foo } = state;
    const html = `
    <div id="root">
      <ul foo="bar">
        <li>one</li> 
        <li>two</li> 
        <li>three</li> 
      </ul>
    </div>
    `;
    // test dom-parser
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, "text/xml");
    const root = doc.querySelector("#root");
    const ul = doc.getElementsByTagName("ul")[0];
    assert(ul.getAttribute("foo") === "bar", "getAttribute() works");
    const listitems = doc.getElementsByTagName("li");
    assert(listitems.length === 3, "getElementsByTagName() selected 3 items");
    const turndown = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      emDelimiter: "*",
    });
    // test turndown
    const parsed = turndown.turndown(html);
    assert(parsed.length > 0, "turndown parsed HTML");

    return {
      [NAME]: str`3P Test`,
      [UI]: (
        <div>
          <h2>3P Test</h2>
        </div>
      ),
    };
  },
);
