import { deepStrictEqual } from "node:assert";
import html from "../html.js";
import * as node from "../node.js";
import * as hole from "../hole.js";
import state from "../state.js";

describe("html", () => {
  it("parses tagged template string into a Renderable", () => {
    const clicks = state<Event | null>('clicks', null);
    const text = state('text', 'Hello world!');

    const renderable = html`
      <div class="container" hidden={{hidden}}>
        <button id="foo" onclick=${clicks}>${text}</button>
      </div>
    `;

    deepStrictEqual(
      renderable.template,
      node.create(
        "div",
        { "class": "container", hidden: hole.create("hidden") },
        [
          node.create(
            "button",
            { id: "foo", onclick: hole.create("clicks") },
            [
              hole.create("text"),
            ]
          ),
        ],
      )
    );
  });
});