import env from "@/env.ts";

/**
 * Authorize an external-ingest write to a channel space.
 *
 * THE THREAT (why this exists): an external presenter self-signs an ordinary
 * `session.open`, and `verifySessionOpenAuthorization` only proves the presenter
 * controls the issuer DID — it proves NOTHING about a relationship to the space
 * the presenter names (`sub` / `auth.space` is attacker-chosen). So an endpoint
 * that writes operator-signed, `ExternalIngest`-stamped bytes into the
 * request-supplied space is a forge hole: any `did:key` holder could deposit
 * trusted-looking provenance into any space. The ingest edge MUST bind the named
 * space to an owner-authorized channel before writing.
 *
 * THIS IS THE INTERIM FAIL-CLOSED STOPGAP. It gates on an explicit allowlist of
 * channel space DIDs (`INGEST_CHANNEL_ALLOWLIST`); default empty => reject all.
 * It does NOT yet verify the presenter's `WRITE` grant on the channel's ACL doc
 * — that, plus the un-spoofable server-side channel registry and per-space
 * enforce, is Step 3 of the grant plan
 * (docs/development/proposals/vouched-ingest-channel-grant-plan.md). When that
 * lands, this allowlist is replaced by the registry + a per-POST forced-fresh
 * read of `of:${channelSpace}` asserting `isCapable(resolveCapability(...), WRITE)`
 * so revocation is effective at the very next ingest.
 */
export class ChannelNotAuthorizedError extends Error {
  constructor(readonly channelSpace: string) {
    super(`Channel space not authorized for ingest: ${channelSpace}`);
    this.name = "ChannelNotAuthorizedError";
  }
}

export const parseIngestChannelAllowlist = (
  csv: string | undefined,
): Set<string> =>
  new Set(
    (csv ?? "")
      .split(",")
      .map((did) => did.trim())
      .filter((did) => did.length > 0),
  );

/**
 * Throw `ChannelNotAuthorizedError` unless `channelSpace` is an authorized
 * ingest channel. Fail-closed: an empty allowlist rejects everything. The
 * allowlist is injectable for testing; in production it comes from
 * `INGEST_CHANNEL_ALLOWLIST`.
 */
export const assertIngestAuthorized = (
  channelSpace: string,
  allowlist: Set<string> = parseIngestChannelAllowlist(
    env.INGEST_CHANNEL_ALLOWLIST,
  ),
): void => {
  if (!allowlist.has(channelSpace)) {
    throw new ChannelNotAuthorizedError(channelSpace);
  }
};
