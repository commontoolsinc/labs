import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  builtinImplementationIdentity,
  deriveImplementationIdentity,
  encodeAnnotatedImplementationIdentity,
  encodeAnnotatedImplementationOrigin,
  encodeImplementationIdentity,
  encodeImplementationOrigin,
  getAnnotatedImplementationIdentity,
  implementationIdentityOrigin,
  unknownImplementationIdentity,
} from "../src/cfc/implementation-identity.ts";
import { lift } from "../src/builder/module.ts";

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
    expect(encodeAnnotatedImplementationOrigin(action)).toBe("Unknown");
    expect(encodeAnnotatedImplementationIdentity({
      cfcImplementationIdentity: unknownImplementationIdentity(),
    })).toBe("Unknown");
  });

  it("derives code hash identity from authored code and retains explicit source origin metadata", () => {
    const double = (x: number) => x * 2;
    const module = lift(double);
    const identity = deriveImplementationIdentity(module);
    const origin = implementationIdentityOrigin(identity);

    expect(identity.kind).toBe("codeHash");
    expect(encodeImplementationIdentity(identity)).toContain("CodeHash(");
    expect(origin?.bundleLocation).toMatch(
      /cfc-implementation-identity\.test\.ts:\d+:\d+$/,
    );
    expect(encodeImplementationOrigin(identity)).toMatch(
      /CodeHash\(.+\) @ .*cfc-implementation-identity\.test\.ts:\d+:\d+$/,
    );
  });
});
