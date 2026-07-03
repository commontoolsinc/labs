import { describe, it } from "@std/testing/bdd";
import * as assert from "./assert.ts";
import { h } from "../src/h.ts";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { createCell } from "../../runner/src/cell.ts";

type BoundValueVNode = {
  props: {
    $value: {
      "/": {
        "link@1": {
          id?: string;
          space?: string;
          path?: readonly unknown[];
        };
      };
    };
  };
};

type CellValueVNode = {
  props: {
    $value: unknown;
  };
};

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

describe("jsx binding props", () => {
  it("stores binding props as explicit cell links", async () => {
    const signer = await Identity.fromPassphrase("jsx binding props");
    const runtime = new Runtime({
      storageManager: StorageManager.emulate({ as: signer }),
      apiUrl: new URL("http://localhost"),
    });
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), "jsx-binding", undefined, tx);
      cell.set("hello");

      const vnode = h(
        "cf-cfc-authorship",
        { $value: cell },
        [],
      ) as unknown as BoundValueVNode;
      const link = vnode.props.$value["/"]["link@1"];

      assert.equal(link.id, cell.getAsNormalizedFullLink().id);
      assert.equal(link.space, signer.did());
      assert.equal(JSON.stringify(link.path), "[]");
    } finally {
      await runtime.dispose();
    }
  });

  it("keeps binding props as cells when standalone evaluation has no link context", async () => {
    const signer = await Identity.fromPassphrase(
      "jsx standalone binding props",
    );
    const runtime = new Runtime({
      storageManager: StorageManager.emulate({ as: signer }),
      apiUrl: new URL("http://localhost"),
    });
    try {
      const cell = createCell(runtime, { path: [] });

      const vnode = h(
        "cf-cfc-authorship",
        { $value: cell },
        [],
      ) as unknown as CellValueVNode;

      assert.equal(vnode.props.$value, cell);
    } finally {
      await runtime.dispose();
    }
  });
});
