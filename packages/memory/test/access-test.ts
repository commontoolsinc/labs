import { assert, assertEquals, assertMatch } from "https://deno.land/std/assert/mod.ts";
import { alice, bob, mallory, space } from "./principal.ts";
import * as Access from "../access.ts";
import { type DID } from "../../identity/src/index.ts";
import { refer } from "../reference.ts";
import { Invocation } from "../interface.ts";

// Some generated service key.
const serviceDid = "did:key:z6MkfJPMCrTyDmurrAHPUsEjCgvcjvLtAuzyZ7nSqwZwb8KQ";

const test = (title: string, run: () => unknown) => {
  const unit = async () => {
    await run();
  };

  if (title.startsWith("only")) {
    Deno.test.only(title, unit);
  } else if (title.startsWith("skip")) {
    Deno.test.ignore(title, unit);
  } else {
    Deno.test(title, unit);
  }
};

test("signer.did()", () => {
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

test("verifier.did()", () => {
  assertEquals(alice.did(), alice.verifier.did());
  assertEquals(bob.did(), bob.verifier.did());
  assertEquals(mallory.did(), mallory.verifier.did());
  assertEquals(space.did(), space.verifier.did());
});

test("Access.authorize <-> Access.claim", async () => {
  const invocation: Invocation = {
    iss: alice.did(),
    cmd: "/test/run",
    sub: alice.did(),
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], alice);
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

test("Fail authorization if issuer is not a subject", async () => {
  const invocation: Invocation = {
    iss: bob.did(),
    cmd: "/test/run",
    sub: alice.did(),
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], bob);
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

test("Fail authorization if subject isn't a did", async () => {
  const invocation: Invocation = {
    iss: bob.did(),
    cmd: "/test/run",
    sub: alice.did().slice(0, -1) as DID,
    args: {},
    prf: [],
  };

  const result = await Access.authorize([refer(invocation)], bob);
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
