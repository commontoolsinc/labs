import { deepStrictEqual } from "node:assert";
import parse from "../parser.js";
import * as node from "../node.js";
import * as hole from "../hole.js";

describe("parse", () => {
  it("parses", () => {
    const xml = `
      <div class="container" hidden={{hidden}}>
        <button id="foo" onclick={{click}}>Hello world!</button>
      </div>
    `;

    const root = parse(xml);

    deepStrictEqual(
      root,
      node.create(
        "documentfragment",
        {},
        [
          node.create(
            "div",
            { class: "container", hidden: hole.create("hidden") },
            [
              node.create(
                "button",
                { id: "foo", onclick: hole.create("click") },
                [
                  "Hello world!",
                ]
              ),
            ]
          ),
        ],
      )
    );
  });
});