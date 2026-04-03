import { describe, it } from "@std/testing/bdd";
import * as assert from "./assert.ts";

describe("jsx dom fragments support", () => {
  it("dom fragments should work", () => {
    const fragment = (
      <>
        <p>Hello world</p>
      </>
    );

    assert.matchObject(
      fragment,
      <cf-fragment>
        <p>Hello world</p>
      </cf-fragment>,
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
      <cf-fragment>
        <p>Grocery List</p>
        <ul>
          <li>Buy Milk</li>
        </ul>
      </cf-fragment>,
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
        <cf-fragment>
          <p>Grocery List</p>
          <ul>
            <li>Buy Milk</li>
          </ul>
        </cf-fragment>
      </div>,
    );
  });
});
