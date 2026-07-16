import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  builtinImplementationHash,
  serverBuiltinImplementationHash,
} from "../src/builtins/server-execution.ts";

// The generalized canonical-builtin identity (W2.11). Its `:v1` shape is
// deliberately distinct from `serverBuiltinImplementationHash`'s `:server-v1`:
// run.ts keys its server-builtin effect-descriptor path on the exact
// `:server-v1` fingerprint, so identity ("this action IS canonical builtin
// <id>") must never be conflated with "the server has a native implementation
// of this external effect".

describe("builtinImplementationHash", () => {
  it("returns the cf:builtin/<id>:v1 static identity", () => {
    expect(builtinImplementationHash("map")).toBe("cf:builtin/map:v1");
    expect(builtinImplementationHash("ifElse")).toBe("cf:builtin/ifElse:v1");
  });

  it("stays distinct from the :server-v1 effect identity", () => {
    // `fetchText` is in the server-executable subset; the two identities for
    // the same id must not collide (run.ts:793 keys on the server-v1 shape).
    expect(builtinImplementationHash("fetchText")).toBe(
      "cf:builtin/fetchText:v1",
    );
    expect(serverBuiltinImplementationHash("fetchText")).toBe(
      "cf:builtin/fetchText:server-v1",
    );
    expect(builtinImplementationHash("fetchText")).not.toBe(
      serverBuiltinImplementationHash("fetchText"),
    );
  });
});
