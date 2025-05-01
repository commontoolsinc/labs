import { beforeEach, describe, it } from "@std/testing/bdd";
import * as assert from "./assert.ts";
import { h } from "../src/jsx.ts";

describe("jsx dom fragments supprot", () => {
  it("dom fragments should work", async () => {
    const fragment = (
      <>
        <p>Hello world</p>
      </>
    );

    assert.matchObject(fragment, [
      <p>Hello world</p>,
    ]);
  });

  it("dom fragments with multiple children", async () => {
    const fragment = (
      <>
        <p>Grocery List</p>
        <ul>
          <li>Buy Milk</li>
        </ul>
      </>
    );

    assert.matchObject(fragment, [
      <p>Grocery List</p>,
      <ul>
        <li>Buy Milk</li>
      </ul>,
    ]);
  });

  it("fragments inside the element", async () => {
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
        <p>Grocery List</p>
        <ul>
          <li>Buy Milk</li>
        </ul>
      </div>,
    );
  });
});
