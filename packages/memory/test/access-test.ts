import { assert, assertEquals, assertMatch } from "@std/assert";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { alice, bob, mallory, space } from "./principal.ts";
import * as Access from "../access.ts";
import { type DID } from "@commonfabric/identity";
import {
  hashOf,
  resetModernHashConfig,
  setModernHashConfig,
} from "@commonfabric/data-model/value-hash";
import { Invocation } from "../interface.ts";

// Some generated service key.
const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

describe("access", () => {
  // Explicitly pin canonical hashing off so these tests exercise the legacy
  // hashOf() path regardless of what the ambient default is.
  beforeAll(() => {
    setModernHashConfig(false);
  });
  afterAll(() => {
    resetModernHashConfig();
  });

  it("signer.did()", () => {
    assertEquals(
      alice.did(),
      "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi",
    );
    assertEquals(
      bob.did(),
      "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob",
    );
    assertEquals(
      mallory.did(),
      "did:key:z6MktafZTREjJkvV5mfJxcLpNBoVPwDLhTuMg9ng7dY4zMAL",
    );
    assertEquals(
      space.did(),
      "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z",
    );
  });

  it("verifier.did()", () => {
    assertEquals(alice.did(), alice.verifier.did());
    assertEquals(bob.did(), bob.verifier.did());
    assertEquals(mallory.did(), mallory.verifier.did());
    assertEquals(space.did(), space.verifier.did());
  });

  it("Access.authorize <-> Access.claim", async () => {
    const invocation: Invocation = {
      iss: alice.did(),
      cmd: "/test/run",
      sub: alice.did(),
      args: {},
      prf: [],
    };

    const result = await Access.authorize([hashOf(invocation)], alice);
    assert(result.ok, "authorization was issued");
    const authorization = result.ok;

    const claim = await Access.claim(invocation, authorization, serviceDid);
    assert(claim.ok, "authorization is valid");

    const unauthorized = await Access.claim(
      {
        iss: alice.did(),
        cmd: "/test/ran",
        sub: alice.did(),
        args: {},
        prf: [],
      },
      authorization,
      serviceDid,
    );

    assertMatch(unauthorized?.error?.message ?? "", /Authorization does not/);
  });

  it("Fail authorization if issuer is not a subject", async () => {
    const invocation: Invocation = {
      iss: bob.did(),
      cmd: "/test/run",
      sub: alice.did(),
      args: {},
      prf: [],
    };

    const result = await Access.authorize([hashOf(invocation)], bob);
    assert(result.ok, "authorization was issued");
    const authorization = result.ok;

    const claim = await Access.claim(invocation, authorization, serviceDid);
    assertMatch(
      claim.error?.message ?? "",
      new RegExp(
        `Principal ${bob.did()} has no authority over ${alice.did()} space`,
      ),
    );
  });

  it("Access.authorize with multiple refs -> each can be claimed", async () => {
    const invocation1: Invocation = {
      iss: alice.did(),
      cmd: "/test/alpha",
      sub: alice.did(),
      args: { n: 1 },
      prf: [],
    };
    const invocation2: Invocation = {
      iss: alice.did(),
      cmd: "/test/beta",
      sub: alice.did(),
      args: { n: 2 },
      prf: [],
    };

    const result = await Access.authorize(
      [hashOf(invocation1), hashOf(invocation2)],
      alice,
    );
    assert(result.ok, "batch authorization was issued");
    const authorization = result.ok;

    const claim1 = await Access.claim(invocation1, authorization, serviceDid);
    assert(claim1.ok, "first invocation is valid");

    const claim2 = await Access.claim(invocation2, authorization, serviceDid);
    assert(claim2.ok, "second invocation is valid");

    const unrelated: Invocation = {
      iss: alice.did(),
      cmd: "/test/gamma",
      sub: alice.did(),
      args: {},
      prf: [],
    };
    const claimUnrelated = await Access.claim(
      unrelated,
      authorization,
      serviceDid,
    );
    assertMatch(
      claimUnrelated?.error?.message ?? "",
      /Authorization does not/,
    );
  });

  it("Fail authorization if subject isn't a did", async () => {
    const invocation: Invocation = {
      iss: bob.did(),
      cmd: "/test/run",
      sub: alice.did().slice(0, -1) as DID,
      args: {},
      prf: [],
    };

    const result = await Access.authorize([hashOf(invocation)], bob);
    assert(result.ok, "authorization was issued");
    const authorization = result.ok;

    const claim = await Access.claim(invocation, authorization, serviceDid);
    assertMatch(
      claim.error?.message ?? "",
      new RegExp(
        `Expected valid did:key identifier instead got "${
          alice.did().slice(0, -1)
        }"`,
      ),
    );
  });
});
