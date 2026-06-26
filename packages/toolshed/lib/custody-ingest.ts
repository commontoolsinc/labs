import type { Cell, IExtendedStorageTransaction } from "@commonfabric/runner";
import { stampExternalIngest } from "@commonfabric/runner/cfc";
import { sha256 } from "@/lib/sha2.ts";

/**
 * The one durable-write path for the fabric's external-ingest edges. An outside
 * service with no DID deposits data into the fabric; a vouched ingest channel
 * marks every value it writes with an unforgeable `ExternalIngest` provenance
 * stamp.
 *
 * This replaces the per-route, hand-rolled durable-write blocks
 * (`oauth2-common.utils.ts` persistTokens/clearAuthData, the divergent
 * non-retry `plaid-oauth.utils.ts` saveAuthData) and the webhook's
 * fire-and-forget `sendToStream` (a transient overwrite, not a durable append)
 * with a single governed write. `custodyIngest.*` adds the provenance mark for
 * the ingest edges; `durableSet` is the same governed write for operator
 * actions that are NOT ingest (clearing tokens, removing an item), which must
 * not carry the mark.
 *
 * The split-mint runs here: the payload is written under the ordinary member
 * identity (so the runtime gate strips any provenance atom an attacker smuggled
 * into it), while `stampExternalIngest` hands the commit pipeline only the
 * *verified channel metadata* — channel, audience, receive time, and a digest
 * of the bytes we wrote — from which it mints the trusted mark. The two never
 * share an authoring identity. See
 * docs/development/proposals/vouched-ingest-channel-mint-design.md.
 *
 * Honest limit: v1 is operator-trusted. This runtime is `as: identity` and sees
 * the plaintext; the split-mint protects the *mark*, not the *bytes*.
 */
export type VouchedChannel = {
  /** The ingest channel — its dedicated space DID. Recorded on every mark. */
  readonly channel: string;
  /**
   * The presenter the grant was vouched to (the external service's DID, or a
   * stable channel-scoped identifier where the presenter has none). Recorded
   * for audit/display; NOT enforced (audience-binding is the federation PR5
   * dependency).
   */
  readonly audience: string;
};

// A digest of the payload bytes the mark binds to. v1 hashes the JSON
// serialization of the parsed value; binding to the exact received bytes is a
// future hardening.
const digestOf = async (payload: unknown): Promise<string> =>
  `sha256:${await sha256(JSON.stringify(payload ?? null))}`;

const durableEdit = async <T>(
  cell: Cell<T>,
  mutate: (tx: IExtendedStorageTransaction) => void,
  ingest?: { channel: VouchedChannel; valueDigest: string },
): Promise<void> => {
  const link = cell.getAsNormalizedFullLink();
  // Operator wall-clock, captured BEFORE the write: retries must not re-stamp
  // the time, and it must never come from the payload.
  const receivedAt = new Date().toISOString();
  const { error } = await cell.runtime.editWithRetry(
    (tx: IExtendedStorageTransaction) => {
      if (ingest !== undefined) {
        stampExternalIngest(tx, {
          channel: ingest.channel.channel,
          audience: ingest.channel.audience,
          receivedAt,
          valueDigest: ingest.valueDigest,
          target: {
            space: link.space,
            id: link.id,
            scope: link.scope,
            path: link.path,
          },
        });
      }
      mutate(tx);
    },
  );
  if (error) throw error;
};

/**
 * Governed durable write with NO ingest mark — the factored replacement for the
 * hand-rolled per-route `editWithRetry` set blocks, for writes that are operator
 * actions rather than external ingest (clearing OAuth tokens, removing an item).
 */
export const durableSet = <T>(cell: Cell<T>, value: T): Promise<void> =>
  durableEdit(cell, (tx) => {
    cell.withTx(tx).set(value);
  });

/**
 * Durably write external data into the fabric under a vouched ingest channel,
 * minting the `ExternalIngest` provenance mark.
 */
export const custodyIngest = {
  /** Durably replace the cell's value (e.g. an OAuth token refresh). */
  async set<T>(
    cell: Cell<T>,
    value: T,
    channel: VouchedChannel,
  ): Promise<void> {
    const valueDigest = await digestOf(value);
    await durableEdit(cell, (tx) => {
      cell.withTx(tx).set(value);
    }, { channel, valueDigest });
  },

  /**
   * Durably append one external record to a list cell (e.g. a webhook event or
   * a location point). The mark binds to the appended element — the external
   * bytes — not the whole accumulated array.
   */
  async append<E>(
    cell: Cell<E[]>,
    element: E,
    channel: VouchedChannel,
  ): Promise<void> {
    const valueDigest = await digestOf(element);
    await durableEdit(cell, (tx) => {
      const bound = cell.withTx(tx);
      const current = (bound.get() as E[] | undefined) ?? [];
      bound.set([...current, element]);
    }, { channel, valueDigest });
  },
} as const;
