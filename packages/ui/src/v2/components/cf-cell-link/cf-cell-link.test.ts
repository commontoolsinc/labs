import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFCellLink } from "./cf-cell-link.ts";
import type { CellRef } from "@commonfabric/runtime-client";

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
      path: [],
      type: "application/json" as CellRef["type"],
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
});
