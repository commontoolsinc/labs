import * as assert from "node:assert";
import html from "../html.js";
import { isVar } from "../view.js";
import { state, stream } from "../state.js";

describe("html", () => {
  it("parses tagged template string into a Renderable", () => {
    const clicks = stream<Event>();
    const text = state("Hello world!");

    const view = html`
      <div class="container">
        <button id="foo" onclick=${clicks}>${text}</button>
      </div>
    `;

    // @ts-ignore - ignore for test
    assert.strict(isVar(view.template.children[0].props.onclick));

    // @ts-ignore - ignore for test
    assert.strict(isVar(view.template.children[0].children[0]));
  });
});
