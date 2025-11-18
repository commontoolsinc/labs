import { describe, it } from "@std/testing/bdd";
import { UI } from "@commontools/api";
import * as assert from "./assert.ts";
import { isVNode } from "../src/jsx.ts";

describe("jsx dom fragments support", () => {
  it("dom fragments should work", () => {
    const fragment = (
      <>
        <p>Hello world</p>
      </>
    );

    assert.matchObject(
      fragment,
      <ct-fragment>
        <p>Hello world</p>
      </ct-fragment>,
    );
  });

  it("dom fragments with multiple children", () => {
    const fragment = (
      <>
        <p>Grocery List</p>
        <ul>
          <li>Buy Milk</li>
        </ul>
      </>
    );

    assert.matchObject(
      fragment,
      <ct-fragment>
        <p>Grocery List</p>
        <ul>
          <li>Buy Milk</li>
        </ul>
      </ct-fragment>,
    );
  });

  it("fragments inside the element", () => {
    const grocery = (
      <>
        <p>Grocery List</p>
        <ul>
          <li>Buy Milk</li>
        </ul>
      </>
    );

    assert.matchObject(
      <div>{grocery}</div>,
      <div>
        <ct-fragment>
          <p>Grocery List</p>
          <ul>
            <li>Buy Milk</li>
          </ul>
        </ct-fragment>
      </div>,
    );
  });
});

describe("isVNode utility", () => {
  it("returns true for a direct VNode", () => {
    const vnode = { type: "vnode", name: "div", props: {}, children: [] };
    assert.equal(isVNode(vnode), true);
  });

  it("returns true for a VNode wrapped in [UI]", () => {
    const vnode = { type: "vnode", name: "div", props: {}, children: [] };
    const wrapped = { [UI]: vnode };
    assert.equal(isVNode(wrapped), true);
  });

  it("returns false for non-VNode objects", () => {
    assert.equal(isVNode({}), false);
    assert.equal(isVNode({ foo: "bar" }), false);
    assert.equal(isVNode([]), false);
    assert.equal(isVNode(null), false);
    assert.equal(isVNode(undefined), false);
    assert.equal(isVNode("string"), false);
    assert.equal(isVNode(123), false);
  });
});
