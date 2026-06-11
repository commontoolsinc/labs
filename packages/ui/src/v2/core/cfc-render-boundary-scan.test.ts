import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  $conn,
  CellHandle,
  type CellRef,
  type RuntimeClient,
} from "@commonfabric/runtime-client";
import { mayContainCfcRenderBoundary } from "./cfc-render-boundary-scan.ts";

const fakeRuntime = {
  [$conn]: () => ({
    request: () => Promise.resolve({}),
    subscribe: () => Promise.resolve(),
    unsubscribe: () => Promise.resolve(),
  }),
} as unknown as RuntimeClient;

function handle(value?: unknown): CellHandle {
  const ref: CellRef = {
    id: "of:boundary-scan-cell" as CellRef["id"],
    space: "did:key:test" as CellRef["space"],
    scope: "space",
    path: [],
  };
  return new CellHandle(fakeRuntime, ref, value);
}

const vnode = (
  name: string,
  props: Record<string, unknown> = {},
  children?: unknown,
) => ({ type: "vnode", name, props, children });

describe("mayContainCfcRenderBoundary", () => {
  it("passes primitives and boundary-free trees", () => {
    expect(mayContainCfcRenderBoundary(undefined)).toBe(false);
    expect(mayContainCfcRenderBoundary(null)).toBe(false);
    expect(mayContainCfcRenderBoundary("hello")).toBe(false);
    expect(mayContainCfcRenderBoundary(42)).toBe(false);
    expect(
      mayContainCfcRenderBoundary(
        vnode("div", { id: "x" }, [
          vnode("span", {}, ["plain text"]),
          "more text",
        ]),
      ),
    ).toBe(false);
  });

  it("flags a boundary at the root", () => {
    expect(
      mayContainCfcRenderBoundary(
        vnode("cf-cfc-render-boundary", {
          maxConfidentiality: [],
          declassifyConfidentiality: ["secret"],
        }, ["guarded"]),
      ),
    ).toBe(true);
  });

  it("flags a boundary nested in children", () => {
    expect(
      mayContainCfcRenderBoundary(
        vnode("div", {}, [
          vnode("p", {}, ["fine"]),
          vnode("section", {}, [
            vnode("cf-cfc-render-boundary", {}, ["guarded"]),
          ]),
        ]),
      ),
    ).toBe(true);
  });

  it("flags by name without requiring a vnode shape", () => {
    // The legacy renderer is lenient about shape; the scan must be at least
    // as lenient when deciding what NOT to render.
    expect(
      mayContainCfcRenderBoundary({ name: "cf-cfc-render-boundary" }),
    ).toBe(true);
  });

  it("does not flag similarly named nodes", () => {
    expect(
      mayContainCfcRenderBoundary(
        vnode("div", {}, [vnode("cf-cfc-render-boundary-ish")]),
      ),
    ).toBe(false);
    // A prop VALUE equal to the tag name is not a node.
    expect(
      mayContainCfcRenderBoundary(
        vnode("div", { title: "cf-cfc-render-boundary" }),
      ),
    ).toBe(false);
  });

  it("flags a boundary carried in a prop value", () => {
    // Reactive/component props can carry vdom subtrees.
    expect(
      mayContainCfcRenderBoundary(
        vnode("cf-some-component", {
          content: vnode("cf-cfc-render-boundary", {}, ["guarded"]),
        }),
      ),
    ).toBe(true);
  });

  it("follows $UI chains", () => {
    expect(
      mayContainCfcRenderBoundary({
        $UI: vnode("div", {}, [vnode("cf-cfc-render-boundary")]),
      }),
    ).toBe(true);
  });

  it("scans the cached value of a nested CellHandle", () => {
    const guarded = handle(vnode("cf-cfc-render-boundary", {}, ["guarded"]));
    expect(
      mayContainCfcRenderBoundary(vnode("div", {}, [guarded])),
    ).toBe(true);

    const benign = handle(vnode("span", {}, ["fine"]));
    expect(
      mayContainCfcRenderBoundary(vnode("div", {}, [benign])),
    ).toBe(false);
  });

  it("treats an unresolved nested CellHandle as boundary-free", () => {
    // Documented limit: nested handles materialized from a parent get() start
    // with no cached value, so treating them as positives would flag nearly
    // every piece UI. Content that streams in later is out of scope.
    expect(
      mayContainCfcRenderBoundary(vnode("div", {}, [handle()])),
    ).toBe(false);
  });

  it("treats a cell whose get() throws as may-contain", () => {
    const broken = handle("ignored");
    (broken as unknown as { get: () => never }).get = () => {
      throw new Error("uninspectable");
    };
    expect(
      mayContainCfcRenderBoundary(vnode("div", {}, [broken])),
    ).toBe(true);
  });

  it("terminates on cyclic trees", () => {
    const cyclic: Record<string, unknown> = vnode("div", {});
    cyclic.children = [cyclic];
    expect(mayContainCfcRenderBoundary(cyclic)).toBe(false);

    const cyclicWithBoundary: Record<string, unknown> = vnode("div", {});
    cyclicWithBoundary.children = [
      cyclicWithBoundary,
      vnode("cf-cfc-render-boundary"),
    ];
    expect(mayContainCfcRenderBoundary(cyclicWithBoundary)).toBe(true);
  });

  it("fails closed on over-deep trees", () => {
    let tree: unknown = vnode("span", {}, ["leaf"]);
    for (let i = 0; i < 100; i++) {
      tree = vnode("div", {}, [tree]);
    }
    expect(mayContainCfcRenderBoundary(tree)).toBe(true);
  });
});
