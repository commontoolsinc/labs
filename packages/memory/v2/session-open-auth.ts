/**
 * Shared verification for the signed `session.open` invocation.
 *
 * The memory server authenticates a client by verifying the signature on its
 * `session.open` invocation; the verified issuer becomes the session principal
 * that storage partitioning keys off. Toolshed's `/api/storage/memory` route
 * and the standalone test server use this shared verifier.
 *
 * The handshake adds three anti-replay checks on top of the signature:
 *
 *  - **expiry** (`exp`): a `session.open` is a live handshake, not a durable
 *    grant. When the invocation carries an `exp` (the client now stamps one),
 *    reject it once expired (with a clock-skew grace). Bounds how long a
 *    captured open can be replayed.
 *
 *  - **challenge** (`challenge`): the server advertises a fresh, connection
 *    scoped challenge in `hello.ok`; the client signs that value into
 *    `session.open`, and the server accepts it once.
 *
 *  - **audience** (`aud`): the invocation must carry this server's audience
 *    identity. An open signed for host A cannot be replayed to host B.
 */
import { hashOf } from "@commonfabric/data-model/value-hash";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { fromDID } from "../util.ts";
import { MEMORY_PROTOCOL, type SessionOpenChallenge } from "../v2.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export const authorizationError = (message: string): Error =>
  Object.assign(new Error(message), { name: "AuthorizationError" });

const sameSessionDescriptor = (
  left: Record<string, unknown>,
  right: { sessionId?: string; seenSeq?: number; sessionToken?: string },
): boolean =>
  (typeof left.sessionId === "string" ? left.sessionId : undefined) ===
    right.sessionId &&
  (typeof left.seenSeq === "number" ? left.seenSeq : undefined) ===
    right.seenSeq &&
  (typeof left.sessionToken === "string" ? left.sessionToken : undefined) ===
    right.sessionToken;

export type SessionOpenMessage = {
  space: string;
  session: { sessionId?: string; seenSeq?: number; sessionToken?: string };
  invocation?: Record<string, unknown>;
  authorization?: unknown;
};

export type VerifySessionOpenOptions = {
  /** This server's own audience identity. */
  audience: string;
  /** The challenge issued to this connection. */
  challenge: SessionOpenChallenge;
  /** Current unix time in seconds (defaults to now). Injectable for tests. */
  nowSeconds?: number;
  /** Grace window for `exp` to tolerate client/server clock skew. */
  clockSkewSeconds?: number;
};

const DEFAULT_CLOCK_SKEW_SECONDS = 120;

/**
 * Verify a `session.open` authorization. Returns the verified issuer DID or
 * throws an AuthorizationError.
 */
export const verifySessionOpenAuthorization = async (
  message: SessionOpenMessage,
  options: VerifySessionOpenOptions,
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

  if (typeof invocation.aud !== "string") {
    throw authorizationError("memory session.open requires audience");
  }
  if (invocation.aud !== options.audience) {
    throw authorizationError("memory session.open audience mismatch");
  }

  if (typeof invocation.challenge !== "string") {
    throw authorizationError("memory session.open requires challenge");
  }
  if (invocation.challenge !== options.challenge.value) {
    throw authorizationError("memory session.open challenge mismatch");
  }
  const challengeNow = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (options.challenge.expiresAt <= challengeNow) {
    throw authorizationError("memory session.open challenge expired");
  }

  if (typeof invocation.iat !== "number" || !Number.isFinite(invocation.iat)) {
    throw authorizationError("memory session.open requires iat");
  }
  if (typeof invocation.exp !== "number" || !Number.isFinite(invocation.exp)) {
    throw authorizationError("memory session.open requires exp");
  }
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);
  const skew = options.clockSkewSeconds ?? DEFAULT_CLOCK_SKEW_SECONDS;
  if (invocation.exp < now - skew) {
    throw authorizationError("memory session.open authorization expired");
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
