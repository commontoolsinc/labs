import * as assert from "node:assert";
import html from "../html.js";
import { isBinding } from "../view.js";
import { cell } from "@commontools/common-propagator";

describe("html", () => {
  it("parses tagged template string into a Renderable", () => {
    const clicks = cell<Event | null>(null);
    const text = cell("Hello world!");

    const view = html`
      <div class="container">
        <button id="foo" onclick=${clicks}>${text}</button>
      </div>
    `;

    // @ts-ignore - ignore for test
    assert.strict(isBinding(view.template.children[0].props.onclick));

    // @ts-ignore - ignore for test
    assert.strict(isBinding(view.template.children[0].children[0]));
  });
});
