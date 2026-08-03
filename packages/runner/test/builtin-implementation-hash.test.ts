import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  builtinImplementationHash,
  isServerExecutableBuiltinId,
  SERVER_EXECUTABLE_BUILTIN_IDS,
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

describe("SERVER_EXECUTABLE_BUILTIN_IDS", () => {
  // A1: `llm` reaches the model through exactly the same `/api/ai/llm` broker
  // route as `generateText` — same `executeWithToolsLoop`, same
  // `llmClientOptions`. Membership here is what earns it the `:server-v1`
  // fingerprint; outside the set it takes the `:v1` identity instead and
  // rejects as `incomplete-static-surface`.
  it("includes `llm`, which shares generateText's broker route", () => {
    expect(SERVER_EXECUTABLE_BUILTIN_IDS).toContain("llm");
    const id: string = "llm";
    expect(isServerExecutableBuiltinId(id)).toBe(true);
    // Guard (not an assertion): narrows `id` for the hash calls below in both
    // the red and green worlds, so this file type-checks either way.
    if (!isServerExecutableBuiltinId(id)) return;
    expect(serverBuiltinImplementationHash(id)).toBe(
      "cf:builtin/llm:server-v1",
    );
    expect(builtinImplementationHash(id)).not.toBe(
      serverBuiltinImplementationHash(id),
    );
  });
});
