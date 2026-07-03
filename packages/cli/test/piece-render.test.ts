import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { render as htmlRender } from "@commonfabric/html/client";
import { UI } from "@commonfabric/runner";
import { renderPiece } from "../lib/piece-render.ts";

describe("renderPiece", () => {
  it("renders watch updates from materialized VNode snapshots", async () => {
    const firstVNode = vnode("section", { "data-state": "first" }, [
      vnode("span", {}, ["First"]),
    ]);
    const secondVNode = vnode("section", { "data-state": "second" }, [
      vnode("span", {}, ["Second"]),
    ]);
    const harness = createRenderPieceHarness(firstVNode);
    const renderedViews: unknown[] = [];
    const updates: string[] = [];

    const cleanup = await renderPiece(
      {
        apiUrl: "http://localhost:8000",
        identity: "/tmp/test-identity.pem",
        piece: "of:piece-123",
        space: "home",
      },
      {
        watch: true,
        onUpdate: (html) => updates.push(html),
      },
      {
        ...harness.deps,
        render(parent, view, options) {
          renderedViews.push(view);
          expect(isVNodeLike(view)).toBe(true);
          return htmlRender(parent, view, options);
        },
      },
    ) as () => void;

    await flushMicrotasks();
    harness.update(secondVNode);
    await flushMicrotasks();
    cleanup();
    harness.update(vnode("section", {}, ["After cleanup"]));
    await flushMicrotasks();

    expect(harness.schema).not.toBeUndefined();
    expect(schemaHasKey(harness.schema, "asCell")).toBe(false);
    expect(renderedViews.length).toBeGreaterThanOrEqual(3);
    expect(updates.length).toBe(2);
    expect(updates[0]).toContain("First");
    expect(updates[1]).toContain("Second");
    expect(updates.join("\n")).not.toContain("After cleanup");
    expect(harness.unsubscribed).toBe(true);
  });
});

function vnode(
  name: string,
  props: Record<string, unknown>,
  children: unknown[],
) {
  return {
    type: "vnode",
    name,
    props,
    children,
  };
}

function isVNodeLike(value: unknown): boolean {
  return typeof value === "object" && value !== null &&
    (value as { type?: unknown }).type === "vnode";
}

function createRenderPieceHarness(initialVNode: unknown) {
  let currentVNode = initialVNode;
  let sinkCallback:
    | ((value: { [UI]?: unknown } | undefined) => void)
    | undefined;
  let schema: unknown;
  let unsubscribed = false;

  const materializedCell = {
    get: () => ({ [UI]: currentVNode }),
    sink(callback: (value: { [UI]?: unknown } | undefined) => void) {
      sinkCallback = callback;
      callback({ [UI]: currentVNode });
      return () => {
        unsubscribed = true;
      };
    },
  };
  const rootCell = {
    asSchema(nextSchema: unknown) {
      schema = nextSchema;
      return materializedCell;
    },
  };
  const piece = {
    getCell: () => rootCell,
  };
  const manager = {
    runtime: {
      idle: () => Promise.resolve(),
    },
  };

  return {
    deps: {
      loadManager: () => Promise.resolve(manager),
      loadPiece: () => Promise.resolve(piece),
    },
    get schema() {
      return schema;
    },
    get unsubscribed() {
      return unsubscribed;
    },
    update(nextVNode: unknown) {
      currentVNode = nextVNode;
      sinkCallback?.({ [UI]: currentVNode });
    },
  };
}

function schemaHasKey(value: unknown, key: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => schemaHasKey(item, key));
  }
  if (typeof value !== "object" || value === null) {
    return false;
  }
  return Object.entries(value).some(([entryKey, entryValue]) =>
    entryKey === key || schemaHasKey(entryValue, key)
  );
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
