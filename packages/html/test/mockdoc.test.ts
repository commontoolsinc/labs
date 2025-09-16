import { describe, it } from "@std/testing/bdd";
import { MockDoc } from "../src/utils.ts";
import { assert } from "@std/assert";

describe("MockDoc", () => {
  it("should render as innerHTML", () => {
    const mock = new MockDoc(
      `<!DOCTYPE html><html><body><div id="root"><span>hello</span></div></body></html>`,
    );
    const root = mock.document.getElementById("root")!;
    assert(root.innerHTML === "<span>hello</span>");
  });

  it("should render as innerHTML after manipulation", () => {
    const mock = new MockDoc(
      `<!DOCTYPE html><html><body><div id="root"><span>hello</span></div></body></html>`,
    );
    const root = mock.document.getElementById("root")!;
    const el = mock.document.createElement("div");
    el.appendChild(mock.document.createTextNode("hi"));
    root.appendChild(el);
    assert(root.innerHTML === "<span>hello</span><div>hi</div>");
    assert(
      mock.document.body.innerHTML ===
        '<div id="root"><span>hello</span><div>hi</div></div>',
    );
    const root2 = mock.document.getElementById("root")!;
    assert(root2.innerHTML === "<span>hello</span><div>hi</div>");
  });
});
