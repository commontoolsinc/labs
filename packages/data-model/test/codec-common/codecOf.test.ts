import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricSpecialObject } from "@/interface.ts";
import { CODEC, codecOf } from "@/codec-common/index.ts";
import { FabricError } from "@/fabric-instances/FabricError.ts";
import { FabricBytes } from "@/fabric-primitives/FabricBytes.ts";

describe("codecOf()", () => {
  it("returns the class's `[CODEC]` for a `FabricInstance`", () => {
    const err = FabricError.fromNativeError(new Error("x"));
    expect(codecOf(err)).toBe(FabricError[CODEC]);
  });

  it("returns `undefined` for a `FabricPrimitive`", () => {
    // A primitive's codec terminates an encoding, so it is bound per wire
    // format under that format's own symbol rather than to `[CODEC]`.
    const fb = new FabricBytes(new Uint8Array([1, 2, 3]));
    expect(codecOf(fb)).toBe(undefined);
  });

  it("returns `undefined` for a `FabricSpecialObject` binding no `[CODEC]`", () => {
    class NoCodec extends FabricSpecialObject {}
    expect(codecOf(new NoCodec())).toBe(undefined);
  });
});
