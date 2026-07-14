import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { alice, bob, mallory, space } from "./principal.ts";
import { MEMORY_PROTOCOL } from "../v2.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { verifySessionOpenAuthorization } from "../v2/session-open-auth.ts";

const now = 1_000_000;
const audience = bob.did();
const challenge = {
  value: "challenge:one",
  expiresAt: now + 60,
};

const signedFields = (
  extra: { aud?: string; challenge?: string; iat?: number; exp?: number } = {},
) => ({
  aud: audience,
  challenge: challenge.value,
  iat: now,
  exp: now + 300,
  ...extra,
});

const verifyOptions = (
  extra: Partial<Parameters<typeof verifySessionOpenAuthorization>[1]> = {},
) => ({
  audience,
  challenge,
  nowSeconds: now,
  ...extra,
});

// Build a signed session.open authorization the same way the production client
// does.
const buildOpen = async (
  extra: { aud?: string; challenge?: string; iat?: number; exp?: number } = {},
  identity = alice,
  session: {
    sessionId?: string;
    seenSeq?: number;
    executionFeedSeq?: number;
    sessionToken?: string;
  } = {},
) => {
  const sub = space.did();
  const invocation: Record<string, unknown> = {
    iss: identity.did(),
    cmd: "session.open",
    sub,
    args: { protocol: MEMORY_PROTOCOL, session },
    ...extra,
  };
  const signature = await identity.sign(hashOf(invocation).bytes);
  if (signature.error) throw signature.error;
  return {
    space: sub,
    session: { ...session },
    invocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  };
};

describe("verifySessionOpenAuthorization", () => {
  it("accepts a valid signed open and returns the issuer principal", async () => {
    assertEquals(
      await verifySessionOpenAuthorization(
        await buildOpen(signedFields()),
        verifyOptions(),
      ),
      alice.did(),
    );
  });

  it("rejects a malformed/unauthorized open", async () => {
    const msg = await buildOpen(signedFields());
    // Tamper with the issuer after signing.
    msg.invocation.iss = bob.did();
    await assertRejects(() =>
      verifySessionOpenAuthorization(msg, verifyOptions())
    );
  });

  it("rejects a resume token changed outside the signed invocation", async () => {
    const msg = await buildOpen(signedFields(), alice, {
      sessionId: "session:resume",
      seenSeq: 7,
      sessionToken: "token:signed",
    });
    msg.session = {
      sessionId: "session:resume",
      seenSeq: 7,
      sessionToken: "token:tampered",
    };
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "authorization mismatch",
    );
  });

  it("accepts an exact signed execution feed cursor", async () => {
    const msg = await buildOpen(signedFields(), alice, {
      sessionId: "session:execution-feed",
      seenSeq: 7,
      executionFeedSeq: 11,
      sessionToken: "token:signed",
    });
    assertEquals(
      await verifySessionOpenAuthorization(msg, verifyOptions()),
      alice.did(),
    );
  });

  it("rejects an execution feed cursor changed outside the signed invocation", async () => {
    const msg = await buildOpen(signedFields(), alice, {
      sessionId: "session:execution-feed",
      seenSeq: 7,
      executionFeedSeq: 11,
      sessionToken: "token:signed",
    });
    msg.session.executionFeedSeq = 12;
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "authorization mismatch",
    );
  });

  // --- expiry ---

  it("accepts an unexpired open", async () => {
    const msg = await buildOpen(signedFields({ iat: now, exp: now + 300 }));
    assertEquals(
      await verifySessionOpenAuthorization(
        msg,
        verifyOptions({
          nowSeconds: now + 10,
        }),
      ),
      alice.did(),
    );
  });

  it("rejects an expired open (beyond the skew grace)", async () => {
    const msg = await buildOpen(
      signedFields({ iat: now - 1000, exp: now - 500 }),
    );
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          msg,
          verifyOptions({
            nowSeconds: now,
            clockSkewSeconds: 120,
          }),
        ),
      Error,
      "expired",
    );
  });

  it("tolerates clock skew within the grace window", async () => {
    const msg = await buildOpen(signedFields({ iat: now, exp: now - 30 }));
    assertEquals(
      await verifySessionOpenAuthorization(
        msg,
        verifyOptions({
          nowSeconds: now,
          clockSkewSeconds: 120,
        }),
      ),
      alice.did(),
    );
  });

  it("rejects a missing issued-at timestamp", async () => {
    const msg = await buildOpen({
      aud: audience,
      challenge: challenge.value,
      exp: now + 300,
    });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires iat",
    );
  });

  it("rejects a missing expiry timestamp", async () => {
    const msg = await buildOpen({
      aud: audience,
      challenge: challenge.value,
      iat: now,
    });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires exp",
    );
  });

  // --- challenge binding ---

  it("accepts a challenged open with the matching challenge", async () => {
    const msg = await buildOpen(signedFields());
    assertEquals(
      await verifySessionOpenAuthorization(msg, verifyOptions()),
      alice.did(),
    );
  });

  it("rejects a missing challenge when one was issued", async () => {
    const msg = await buildOpen({ aud: audience });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires challenge",
    );
  });

  it("rejects the wrong challenge", async () => {
    const msg = await buildOpen(signedFields({ challenge: "challenge:other" }));
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "challenge mismatch",
    );
  });

  it("rejects an expired challenge", async () => {
    const msg = await buildOpen(signedFields());
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          msg,
          verifyOptions({
            challenge: {
              value: challenge.value,
              expiresAt: now,
            },
            nowSeconds: now,
          }),
        ),
      Error,
      "challenge expired",
    );
  });

  // --- audience binding ---

  it("accepts an audience-bound open at the matching host", async () => {
    assertEquals(
      await verifySessionOpenAuthorization(
        await buildOpen(signedFields()),
        verifyOptions(),
      ),
      alice.did(),
    );
  });

  it("rejects a missing audience when the server configures one", async () => {
    const msg = await buildOpen({ challenge: challenge.value });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, verifyOptions()),
      Error,
      "requires audience",
    );
  });

  it("rejects an audience-bound open replayed to a different host", async () => {
    const msg = await buildOpen(signedFields());
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(
          msg,
          verifyOptions({
            audience: mallory.did(),
          }),
        ),
      Error,
      "audience mismatch",
    );
  });
});
