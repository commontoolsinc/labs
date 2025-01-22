import { markAsStatic } from "@commontools/common-builder";
import { view, section, parse, binding, vnode, parsePath } from "../view.js";
import * as assert from "node:assert/strict";

describe("view()", () => {
  it("parses a context and string template into a view", () => {
    const hello = view("<div>Hello world!</div>", {});
    assert.deepStrictEqual(hello, markAsStatic({
      type: "view",
      template: vnode("div", {}, ["Hello world!"]),
      context: {},
    }));
  });

  it("parses a context and string template into a view (2)", () => {
    const hello = view("<div hidden={{hidden}}>{{text}}</div>", {
      hidden: false,
      text: "Hello world!",
    });
    assert.deepStrictEqual(hello, markAsStatic({
      type: "view",
      template: vnode("div", { hidden: binding("hidden") }, [binding("text")]),
      context: {
        hidden: false,
        text: "Hello world!",
      },
    }));
  });
});

describe("parse()", () => {
  it("parses", () => {
    const xml = `
      <div class="container" hidden={{hidden}}>
        <button id="foo" onclick={{click}}>Hello world!</button>
      </div>
    `;

    const root = parse(xml);

    assert.deepEqual(
      root,
      vnode("documentfragment", {}, [
        vnode("div", { class: "container", hidden: binding("hidden") }, [
          vnode("button", { id: "foo", onclick: binding("click") }, [
            "Hello world!",
          ]),
        ]),
      ]),
    );
  });

  it("parses mustache blocks embedded in HTML", () => {
    const xml = `
      <div class="container">
        {{#items}}
          <div class="item">{{text}}</div>
        {{/items}}
      </div>
    `;

    const root = parse(xml);

    assert.deepEqual(
      root,
      vnode("documentfragment", {}, [
        vnode("div", { class: "container" }, [
          section("items", [
            vnode("div", { class: "item" }, [binding("text")]),
          ]),
        ]),
      ]),
    );
  });
});

describe("parsePath()", () => {
  it("parses paths without dots", () => {
    assert.deepEqual(parsePath("foo"), ["foo"]);
  });

  it("parses paths with dots", () => {
    assert.deepEqual(parsePath("foo.bar.baz"), ["foo", "bar", "baz"]);
  });

  it("parses path with only a dot", () => {
    assert.deepEqual(parsePath("."), []);
  });
});
