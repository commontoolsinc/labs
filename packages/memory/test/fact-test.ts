import { assertEquals, assertFalse, assertStrictEquals } from "@std/assert";
import { FabricHash } from "@commonfabric/data-model/fabric-primitives";
import { hashOf } from "@commonfabric/data-model/value-hash";
import {
  assert as assertFact,
  claimState,
  normalizeFact,
  retract,
  unclaimed,
  unclaimedRef,
} from "../fact.ts";

const the = "application/json";
const of = "memory:test";

Deno.test("normalizeFact accepts linked cause strings", () => {
  const cause = hashOf({ test: "linked cause" });

  const assertion = normalizeFact({
    the,
    of,
    is: { ok: true },
    cause: { "/": cause.taggedHashString },
  });

  assertEquals(assertion.cause.taggedHashString, cause.taggedHashString);
  assertEquals(assertion.is, { ok: true });

  const retraction = normalizeFact({
    the,
    of,
    cause: { "/": cause.taggedHashString },
  });

  assertEquals(retraction.cause.taggedHashString, cause.taggedHashString);
  assertFalse("is" in retraction);
});

Deno.test("normalizeFact preserves FabricHash causes", () => {
  const cause = FabricHash.fromString(hashOf("direct cause").taggedHashString);

  const assertion = normalizeFact({
    the,
    of,
    is: "value",
    cause,
  });

  assertStrictEquals(assertion.cause, cause);
});

Deno.test("normalizeFact derives missing and fact causes", () => {
  const assertion = normalizeFact({
    the,
    of,
    is: 42,
  });

  assertEquals(assertion.cause, unclaimedRef({ the, of }));

  const child = normalizeFact({
    the,
    of,
    is: "child",
    cause: assertion,
  });

  assertEquals(
    child.cause,
    hashOf({
      the: assertion.the,
      of: assertion.of,
      cause: assertion.cause,
      is: assertion.is,
    }),
  );
});

Deno.test("fact helpers build unclaimed, assertion, retraction, and invariant facts", () => {
  const base = assertFact({
    the,
    of,
    is: "value",
  });

  assertEquals(unclaimed({ the, of }), { the, of });
  assertEquals(base.cause, unclaimedRef({ the, of }));

  const withFactCause = assertFact({
    the,
    of,
    is: "next",
    cause: base,
  });
  assertEquals(
    withFactCause.cause,
    hashOf({
      the: base.the,
      of: base.of,
      cause: base.cause,
      is: base.is,
    }),
  );

  const removed = retract(base);
  assertEquals(removed.the, the);
  assertEquals(removed.of, of);
  assertFalse("is" in removed);

  const invariant = claimState(base);
  assertEquals(invariant.the, the);
  assertEquals(invariant.of, of);
  assertEquals(invariant.fact, hashOf(normalizeFact(base)));
});
