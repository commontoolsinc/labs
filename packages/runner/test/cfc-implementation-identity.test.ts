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
  implementationIdentityIntegrityAtom,
  implementationIdentityOrigin,
  unknownImplementationIdentity,
} from "../src/cfc/implementation-identity.ts";
import { implementationIdentityAtom, lift } from "../src/builder/module.ts";
import { attachImplementationSourceOrigin } from "../src/builder/source-origin.ts";

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

  it("keeps code hashes stable across debug-origin differences", () => {
    const fnA = (x: number) => x * 2;
    Object.defineProperty(fnA, "name", { value: "bundle-a.js:10:2" });
    (fnA as { src?: string }).src = "bundle-a.js:10:2";
    attachImplementationSourceOrigin(fnA, {
      bundleLocation: "bundle-a.js:10:2",
      sourceLocation: "/tmp/a.tsx:10:2",
    });

    const fnB = (x: number) => x * 2;
    Object.defineProperty(fnB, "name", { value: "bundle-b.js:900:1" });
    (fnB as { src?: string }).src = "bundle-b.js:900:1";
    attachImplementationSourceOrigin(fnB, {
      bundleLocation: "bundle-b.js:900:1",
      sourceLocation: "/tmp/b.tsx:900:1",
    });

    const identityA = deriveImplementationIdentity({
      type: "javascript",
      implementation: fnA,
    });
    const identityB = deriveImplementationIdentity({
      type: "javascript",
      implementation: fnB,
    });

    const hashA = identityA.kind === "codeHash" ? identityA.hash : undefined;
    const hashB = identityB.kind === "codeHash" ? identityB.hash : undefined;

    expect(hashA).toBe(hashB);
  });

  it("exposes a concrete implementation integrity atom for authored handlers/modules", () => {
    const double = (x: number) => x * 2;
    const module = lift(double);
    const identity = deriveImplementationIdentity(module);

    expect(implementationIdentityAtom(module)).toEqual(
      implementationIdentityIntegrityAtom(identity),
    );
  });
});
