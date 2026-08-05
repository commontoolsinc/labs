// A `FabricPrimitive` keeps its state in private fields and has no enumerable
// own properties, so a walk that rebuilds a record from its entries turns one
// into a bare `{}`. The conversion stands it whole instead.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  FabricBytes,
  FabricEpochNsec,
} from "@commonfabric/data-model/fabric-primitives";

import { convertCellsToLinks } from "../src/cell.ts";

describe("convert-cells-to-links-special-objects", () => {
  it("returns a `FabricBytes` whole rather than as an empty record", () => {
    const bytes = new FabricBytes(new Uint8Array([1, 2, 3]));
    const result = convertCellsToLinks({ x: bytes }) as { x: unknown };

    // `toBeInstanceOf` is the assertion that can fail here: a flattened `{}`
    // is `toEqual`-equal to a `FabricBytes` with no enumerable members, so
    // that matcher alone would pass against the very bug this pins.
    expect(result.x).toBeInstanceOf(FabricBytes);
    expect((result.x as FabricBytes).slice()).toEqual(
      new Uint8Array([1, 2, 3]),
    );
  });

  it("returns a native `Uint8Array` as a whole `FabricBytes`", () => {
    // The other form that reaches the leaf branch: minted by the shallow
    // conversion on the way in rather than handed over already built.
    const result = convertCellsToLinks({
      x: new Uint8Array([4, 5]),
    }) as { x: unknown };

    expect(result.x).toBeInstanceOf(FabricBytes);
    expect((result.x as FabricBytes).slice()).toEqual(new Uint8Array([4, 5]));
  });

  it("returns a native `Date` as a whole `FabricEpochNsec`", () => {
    const result = convertCellsToLinks({ x: new Date(1000) }) as { x: unknown };

    expect(result.x).toBeInstanceOf(FabricEpochNsec);
    expect((result.x as FabricEpochNsec).value).toBe(1_000_000_000n);
  });

  it("returns a `FabricPrimitive` reachable twice at both positions", () => {
    // The leaf branch exits without descending, and every such exit must still
    // clear the ancestor it recorded. One that did not would leave the value an
    // ancestor for the rest of the walk, and the second position holding it
    // would come back a back-link to the first.
    const shared = new FabricBytes(new Uint8Array([7]));
    const result = convertCellsToLinks({ a: shared, b: shared }) as {
      a: unknown;
      b: unknown;
    };

    expect(result.a).toBeInstanceOf(FabricBytes);
    expect(result.b).toBeInstanceOf(FabricBytes);
  });
});
