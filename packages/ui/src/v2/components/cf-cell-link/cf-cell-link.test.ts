import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFCellLink } from "./index.ts";
import type { CellRef } from "@commonfabric/runtime-client";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function markConnected(element: CFCellLink, isConnected = true): void {
  Object.defineProperty(element, "isConnected", {
    configurable: true,
    value: isConnected,
  });
}

describe("CFCellLink", () => {
  it("should be defined", () => {
    expect(CFCellLink).toBeDefined();
  });

  it("should have customElement definition", () => {
    const definition = customElements.get("cf-cell-link");
    expect(definition).toBeDefined();
    expect(definition).toBe(CFCellLink);
  });

  it("should create element instance", () => {
    const element = new CFCellLink();
    expect(element).toBeInstanceOf(CFCellLink);
  });

  it("should have default properties", () => {
    const element = new CFCellLink();
    expect(element.link).toBeUndefined();
    expect(element.cell).toBeUndefined();
    expect(element.runtime).toBeUndefined();
    expect(element.space).toBeUndefined();
  });

  it("does not resubscribe when the resolved cell ref is unchanged", () => {
    const ref: CellRef = {
      id: "of:test-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    const makeCell = (cellRef: CellRef) =>
      ({
        ref: () => cellRef,
        asSchema: () => ({
          subscribe: () => {
            subscribeCount++;
            return () => {
              unsubscribeCount++;
            };
          },
        }),
      }) as any;

    const element = new CFCellLink() as any;
    markConnected(element);
    element._resolvedCell = makeCell(ref);
    element._updateSubscription();
    element._updateSubscription();

    expect(subscribeCount).toBe(1);
    expect(unsubscribeCount).toBe(0);

    element._resolvedCell = makeCell({
      ...ref,
      id: "of:other-cell" as CellRef["id"],
    });
    element._updateSubscription();

    expect(subscribeCount).toBe(2);
    expect(unsubscribeCount).toBe(1);
  });

  it("resubscribes when the resolved handle changes with the same ref", () => {
    const ref: CellRef = {
      id: "of:test-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    const activeSubscriptions = new Set<string>();
    let unsubscribeCount = 0;
    const makeCell = (label: string) =>
      ({
        ref: () => ref,
        asSchema: () => ({
          subscribe: () => {
            activeSubscriptions.add(label);
            return () => {
              activeSubscriptions.delete(label);
              unsubscribeCount++;
            };
          },
        }),
      }) as any;

    const element = new CFCellLink() as any;
    markConnected(element);
    element._setResolvedCell(makeCell("first"));
    element._updateSubscription();

    element._setResolvedCell(makeCell("second"));
    element._updateSubscription();

    expect(activeSubscriptions.has("first")).toBe(false);
    expect(activeSubscriptions.has("second")).toBe(true);
    expect(unsubscribeCount).toBe(1);
  });

  it("ignores stale async cell resolutions after a later cell is selected", async () => {
    const refA: CellRef = {
      id: "of:slow-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    const refB: CellRef = {
      ...refA,
      id: "of:fast-cell" as CellRef["id"],
    };

    const activeSubscriptions = new Set<string>();
    const subscribeCounts = new Map<string, number>();
    const unsubscribeCounts = new Map<string, number>();
    const makeResolvedCell = (cellRef: CellRef) =>
      ({
        ref: () => cellRef,
        asSchema: () => ({
          subscribe: () => {
            activeSubscriptions.add(cellRef.id);
            subscribeCounts.set(
              cellRef.id,
              (subscribeCounts.get(cellRef.id) ?? 0) + 1,
            );
            return () => {
              activeSubscriptions.delete(cellRef.id);
              unsubscribeCounts.set(
                cellRef.id,
                (unsubscribeCounts.get(cellRef.id) ?? 0) + 1,
              );
            };
          },
        }),
      }) as any;

    const slowResolution = deferred<any>();
    const slowCell = {
      ref: () => refA,
      resolveAsCell: () => slowResolution.promise,
    };
    const fastCell = {
      ref: () => refB,
      resolveAsCell: () => Promise.resolve(makeResolvedCell(refB)),
    };

    const element = new CFCellLink() as any;
    markConnected(element);
    element.cell = slowCell;
    const slowResolveStarted = element._resolveCell();

    element.cell = fastCell;
    await element._resolveCell();
    element._updateSubscription();

    expect(activeSubscriptions.has(refB.id)).toBe(true);
    expect(activeSubscriptions.has(refA.id)).toBe(false);

    slowResolution.resolve(makeResolvedCell(refA));
    await slowResolveStarted;
    element._updateSubscription();

    expect(subscribeCounts.get(refA.id) ?? 0).toBe(0);
    expect(unsubscribeCounts.get(refB.id) ?? 0).toBe(0);
    expect(activeSubscriptions.has(refB.id)).toBe(true);
    expect(activeSubscriptions.has(refA.id)).toBe(false);
  });

  it("does not subscribe before the element is connected", () => {
    const ref: CellRef = {
      id: "of:detached-cell" as CellRef["id"],
      space: "did:key:test-space" as CellRef["space"],
      scope: "space",
      path: [],
      schema: { type: "object" },
    };
    let subscribeCount = 0;
    const cell = {
      ref: () => ref,
      asSchema: () => ({
        subscribe: () => {
          subscribeCount++;
          return () => {};
        },
      }),
    };

    const element = new CFCellLink() as any;
    element._resolvedCell = cell;
    element._updateSubscription();

    expect(subscribeCount).toBe(0);

    markConnected(element);
    element._updateSubscription();

    expect(subscribeCount).toBe(1);
  });
});
