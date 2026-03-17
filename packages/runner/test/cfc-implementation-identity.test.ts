import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  builtinImplementationIdentity,
  encodeAnnotatedImplementationIdentity,
  getAnnotatedImplementationIdentity,
  unknownImplementationIdentity,
} from "../src/cfc/implementation-identity.ts";

describe("CFC implementation identity helpers", () => {
  it("reads and encodes identity from wrapped action metadata", () => {
    const action = Object.assign(() => undefined, {
      cfcImplementationIdentity: builtinImplementationIdentity("map"),
    });

    expect(getAnnotatedImplementationIdentity(action)).toEqual(
      builtinImplementationIdentity("map"),
    );
    expect(encodeAnnotatedImplementationIdentity(action)).toBe("Builtin(map)");
  });

  it("treats missing wrapped action metadata as unknown", () => {
    const action = () => undefined;

    expect(getAnnotatedImplementationIdentity(action)).toBeUndefined();
    expect(encodeAnnotatedImplementationIdentity(action)).toBe("Unknown");
    expect(encodeAnnotatedImplementationIdentity({
      cfcImplementationIdentity: unknownImplementationIdentity(),
    })).toBe("Unknown");
  });
});
