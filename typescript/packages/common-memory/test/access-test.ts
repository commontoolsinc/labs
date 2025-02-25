import { assert, assertEquals, assertMatch } from "jsr:@std/assert";
import { alice, bob, mallory, space } from "./principal.ts";
import * as Access from "../access.ts";
import { refer } from "../reference.ts";
import { Invocation } from "../interface.ts";

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
  assertEquals(alice.did(), "did:key:z6Mkk89bC3JrVqKie71YEcc5M1SMVxuCgNx6zLZ8SYJsxALi");
  assertEquals(bob.did(), "did:key:z6MkffDZCkCTWreg8868fG1FGFogcJj5X6PY93pPcWDn9bob");
  assertEquals(mallory.did(), "did:key:z6MktafZTREjJkvV5mfJxcLpNBoVPwDLhTuMg9ng7dY4zMAL");
  assertEquals(space.did(), "did:key:z6MkrZ1r5XBFZjBU34qyD8fueMbMRkKw17BZaq2ivKFjnz2z");
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

  const claim = await Access.claim(invocation, authorization);
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
  );

  assertMatch(unauthorized?.error?.message ?? "", /Authorization does not/);
});
