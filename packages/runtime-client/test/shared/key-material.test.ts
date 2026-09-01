import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";

import { findKeyMaterial } from "@/shared/key-material.ts";

const keyPair = new FabricKeyPair(
  "Ed25519",
  new Uint8Array(32),
  new Uint8Array(32),
);

describe("findKeyMaterial()", () => {
  it("returns `undefined` for a value holding none", () => {
    expect(findKeyMaterial({
      identity: "did:key:z6Mk-someone",
      trustSnapshot: { id: "principal:did:key:z6Mk-someone" },
      atoms: [{ type: "Resource", subject: "did:key:z6Mk-someone" }],
    })).toBeUndefined();
  });

  it("returns `undefined` for a primitive", () => {
    expect(findKeyMaterial("did:key:z6Mk-someone")).toBeUndefined();
    expect(findKeyMaterial(undefined)).toBeUndefined();
    expect(findKeyMaterial(42)).toBeUndefined();
  });

  it("names the field a key pair sits directly under", () => {
    expect(findKeyMaterial({ identity: keyPair })).toBe("identity");
  });

  it("names the path of a key pair nested inside", () => {
    expect(findKeyMaterial({ trustSnapshot: { signer: keyPair } })).toBe(
      "trustSnapshot.signer",
    );
  });

  it("names the index of a key pair inside an array", () => {
    expect(findKeyMaterial({ atoms: [{}, { key: keyPair }] })).toBe(
      "atoms[1].key",
    );
  });

  it("names the value itself when it is a key pair", () => {
    expect(findKeyMaterial(keyPair)).toBe("");
  });

  it("returns `undefined` for a cycle holding no key material", () => {
    // A context built on this side of the wire has not been through a decode,
    // so nothing has flattened it into a tree first.
    const cyclic: Record<string, unknown> = { identity: "did:key:z6Mk-a" };
    cyclic.self = cyclic;
    expect(findKeyMaterial(cyclic)).toBeUndefined();
  });

  it("finds a key pair reached past a cycle", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    cyclic.trustSnapshot = { signer: keyPair };
    expect(findKeyMaterial(cyclic)).toBe("trustSnapshot.signer");
  });
});
