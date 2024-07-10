import { assert, equal as assertEqual } from "./assert.js";
import { render } from "../render.js";
import { html } from "../html.js";
import { setDebug } from "../log.js";
import state from "../state.js";

setDebug(true);

describe("render", () => {
  it("binds attributes", () => {
    const title = "world";
    const template = html`<button title="${title}">Hello</div>`;
    const element = render(template);
    assert(element instanceof HTMLButtonElement);
    assertEqual(element.getAttribute("title"), "world");
  });

  it("coerces attribute values to strings", () => {
    const title = 100;
    const template = html`<button title="${title}">Hello</div>`;
    const element = render(template);
    assert(element instanceof HTMLButtonElement);
    assertEqual(element.getAttribute("title"), "100");
  });

  it("binds reactive values to attributes", () => {
    const title = state("world");
    const template = html`<button title="${title}">Hello</div>`;

    const element = render(template) as HTMLButtonElement;
    assert(element instanceof HTMLButtonElement);
    assertEqual(element.getAttribute("title"), "world");

    title.send("reactivity");
    assertEqual(element.getAttribute("title"), "reactivity");
  });

  it("binds properties", () => {
    const hidden = true;
    const template = html`<button .hidden=${hidden}>Hello</div>`;
    const element = render(template) as HTMLButtonElement;
    assert(element instanceof HTMLButtonElement);
    assertEqual(element.hidden, true);
    assert(element.hasAttribute("hidden"));
  });

  it("refuses to bind event properties", () => {
    const onclick = () => {
      console.log("clicked");
    };
    const template = html`<button .onclick=${onclick}>Hello</div>`;
    const element = render(template) as HTMLButtonElement;
    assert(element instanceof HTMLButtonElement);
    assertEqual(element.onclick, null);
  });

  it("binds reactive values to properties", () => {
    const hidden = state(true);
    const template = html`<button .hidden=${hidden}>Hello</div>`;

    const element = render(template) as HTMLButtonElement;
    assert(element instanceof HTMLButtonElement);
    // @ts-ignore - inacurate types. Element does have hidden property.
    assertEqual(element.hidden, true);
    assert(element.hasAttribute("hidden"));

    hidden.send(false);

    assertEqual(element.hidden, false);
    assert(!element.hasAttribute("hidden"));
  });

  it("binds listener functions to events", () => {
    const hidden = state(true);
    const template = html`<button .hidden=${hidden}>Hello</div>`;

    const element = render(template) as HTMLButtonElement;
    assert(element instanceof HTMLButtonElement);
    assertEqual(element.hidden, true);
    assert(element.hasAttribute("hidden"));

    hidden.send(false);

    assertEqual(element.hidden, false);
    assert(!element.hasAttribute("hidden"));
  });

  it("binds sendables to events", () => {
    let called = 0;
    const sendable = {
      send: (_value: Event) => {
        called++;
      }
    };
    const template = html`<button @click=${sendable}>Hello</div>`;

    const element = render(template) as HTMLButtonElement;

    element.click();
    element.click();
    element.click();

    assertEqual(called, 3);
  });

  // it("renders children as text nodes", () => {
  //   const name = "world";
  //   const template = html`<div>Hello, ${name}</div>`;
  //   const element = render(template);
  //   assert(element instanceof HTMLDivElement);
  //   assertEqual(element.textContent, "Hello, world");
  //   console.log(element.textContent);
  // });
});
