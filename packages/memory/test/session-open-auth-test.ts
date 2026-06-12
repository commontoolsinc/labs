import { assertEquals, assertRejects } from "@std/assert";
import { describe, it } from "@std/testing/bdd";
import { alice, bob, mallory, space } from "./principal.ts";
import { MEMORY_PROTOCOL } from "../v2.ts";
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { verifySessionOpenAuthorization } from "../v2/session-open-auth.ts";

// Build a signed session.open authorization the same way the production client
// (v2-remote-session.ts) does, with optional aud/iat/exp for the PR5 checks.
const buildOpen = async (
  extra: { aud?: string; iat?: number; exp?: number } = {},
  identity = alice,
) => {
  const session = {};
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
    session,
    invocation,
    authorization: { signature: new FabricBytes(signature.ok) },
  };
};

describe("verifySessionOpenAuthorization", () => {
  it("accepts a valid signed open and returns the issuer principal", async () => {
    assertEquals(
      await verifySessionOpenAuthorization(await buildOpen()),
      alice.did(),
    );
  });

  it("rejects a malformed/unauthorized open", async () => {
    const msg = await buildOpen();
    // Tamper with the issuer after signing — the signature no longer verifies.
    msg.invocation.iss = bob.did();
    await assertRejects(() => verifySessionOpenAuthorization(msg));
  });

  // --- expiry (no audience identity needed) ---

  it("accepts an unexpired open", async () => {
    const now = 1_000_000;
    const msg = await buildOpen({ iat: now, exp: now + 300 });
    assertEquals(
      await verifySessionOpenAuthorization(msg, { nowSeconds: now + 10 }),
      alice.did(),
    );
  });

  it("rejects an expired open (beyond the skew grace)", async () => {
    const now = 1_000_000;
    const msg = await buildOpen({ iat: now - 1000, exp: now - 500 });
    await assertRejects(
      () =>
        verifySessionOpenAuthorization(msg, {
          nowSeconds: now,
          clockSkewSeconds: 120,
        }),
      Error,
      "expired",
    );
  });

  it("tolerates clock skew within the grace window", async () => {
    const now = 1_000_000;
    const msg = await buildOpen({ iat: now, exp: now - 30 }); // just expired
    assertEquals(
      await verifySessionOpenAuthorization(msg, {
        nowSeconds: now,
        clockSkewSeconds: 120,
      }),
      alice.did(),
    );
  });

  // --- audience binding (the cross-host replay fix) ---

  it("accepts an audience-bound open at the matching host", async () => {
    const aud = bob.did(); // stand-in for the host's audience identity
    assertEquals(
      await verifySessionOpenAuthorization(await buildOpen({ aud }), {
        audience: aud,
      }),
      alice.did(),
    );
  });

  it("rejects an audience-bound open replayed to a different host", async () => {
    const msg = await buildOpen({ aud: bob.did() });
    await assertRejects(
      () => verifySessionOpenAuthorization(msg, { audience: mallory.did() }),
      Error,
      "audience mismatch",
    );
  });

  it("ignores aud when the server configures no audience (opt-in rollout)", async () => {
    // Until the memory server has an audience identity, an aud-bearing open is
    // still accepted (no audience option passed) — so the client change can
    // land before the server one.
    assertEquals(
      await verifySessionOpenAuthorization(await buildOpen({ aud: bob.did() })),
      alice.did(),
    );
  });
});
