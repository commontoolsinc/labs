/**
 * Shared verification for the signed `session.open` invocation.
 *
 * The memory server authenticates a client by verifying the signature on its
 * `session.open` invocation; the verified issuer becomes the session principal
 * that storage partitioning keys off. Toolshed's `/api/storage/memory` route
 * and the standalone test server both performed this verification with
 * byte-identical copies — this is the single source of truth they now share.
 *
 * Federation §14 PR5 adds two anti-replay checks on top of the signature:
 *
 *  - **expiry** (`exp`): a `session.open` is a live handshake, not a durable
 *    grant. When the invocation carries an `exp` (the client now stamps one),
 *    reject it once expired (with a clock-skew grace). Bounds how long a
 *    captured open can be replayed.
 *
 *  - **audience** (`aud`): when the invocation is bound to an audience AND this
 *    server is configured with its own `audience` identity, require they match
 *    — so an open signed for host A cannot be replayed to host B. This is the
 *    cross-host replay fix that lets the site table's host hints become
 *    trustable. Both halves are opt-in (absent `aud` or unconfigured server →
 *    skip) so the check rolls out without a flag day. NOTE: the `Invocation`
 *    `aud` field is typed `DID`, so a *proper* audience is the server's own
 *    identity DID — which the memory server does not have today. Provisioning
 *    that identity (and letting the client discover it, e.g. via the site
 *    table) is the open architectural decision tracked in
 *    docs/development/federation-pr5-design.md; until it lands no client sets
 *    `aud` and this stays inert. The mechanism + tests are here so that
 *    decision is a wiring change, not a protocol change.
 */
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { fromDID } from "../util.ts";
import { MEMORY_PROTOCOL } from "../v2.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const sameSessionDescriptor = (
  left: Record<string, unknown>,
  right: { sessionId?: string; seenSeq?: number },
): boolean =>
  (typeof left.sessionId === "string" ? left.sessionId : undefined) ===
    right.sessionId &&
  (typeof left.seenSeq === "number" ? left.seenSeq : undefined) ===
    right.seenSeq;

export type SessionOpenMessage = {
  space: string;
  session: { sessionId?: string; seenSeq?: number };
  invocation?: Record<string, unknown>;
  authorization?: unknown;
};

export type VerifySessionOpenOptions = {
  /** This server's own audience identity (a DID). When set, an invocation that
   * carries an `aud` must match it. Unset → audience is not enforced. */
  audience?: string;
  /** Current unix time in seconds (defaults to now). Injectable for tests. */
  nowSeconds?: number;
  /** Grace window for `exp` to tolerate client/server clock skew. */
  clockSkewSeconds?: number;
};

const DEFAULT_CLOCK_SKEW_SECONDS = 120;

/**
 * Verify a `session.open` authorization. Returns the verified issuer DID (the
 * session principal) or throws an AuthorizationError. Behaviour matches the
 * prior inline copies exactly, plus the opt-in expiry/audience checks above.
 */
export const verifySessionOpenAuthorization = async (
  message: SessionOpenMessage,
  options: VerifySessionOpenOptions = {},
): Promise<string> => {
  const rawSignature = isRecord(message.authorization)
    ? message.authorization.signature
    : undefined;
  const signature = rawSignature instanceof FabricBytes
    ? rawSignature.slice()
    : null;
  if (!isRecord(message.invocation) || signature === null) {
    throw authorizationError("memory session.open requires authorization");
  }

  const invocation = message.invocation;
  if (
    typeof invocation.iss !== "string" ||
    invocation.cmd !== "session.open" ||
    invocation.sub !== message.space ||
    !isRecord(invocation.args) ||
    invocation.args.protocol !== MEMORY_PROTOCOL ||
    !isRecord(invocation.args.session) ||
    !sameSessionDescriptor(invocation.args.session, message.session)
  ) {
    throw authorizationError("memory session.open authorization mismatch");
  }

  // Audience binding: an open bound to a *different* audience must not be
  // accepted here (replay across hosts). Opt-in on both sides.
  if (
    options.audience !== undefined &&
    invocation.aud !== undefined &&
    invocation.aud !== options.audience
  ) {
    throw authorizationError(
      "memory session.open audience mismatch (replayed to the wrong host)",
    );
  }

  // Expiry: a captured open must not be replayable forever.
  if (invocation.exp !== undefined) {
    if (typeof invocation.exp !== "number") {
      throw authorizationError("memory session.open has a malformed exp");
    }
    const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
    const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
    if (invocation.exp < now - skew) {
      throw authorizationError("memory session.open authorization expired");
    }
  }

  const issuer = await fromDID(invocation.iss);
  if (issuer.error) {
    throw issuer.error;
  }

  const verified = await issuer.ok.verify({
    payload: hashOf(invocation).bytes,
    signature,
  });
  if (verified.error) {
    throw verified.error;
  }

  return invocation.iss;
};
