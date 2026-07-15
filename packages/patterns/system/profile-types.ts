import type { Cell, RequiresIntegrity } from "commonfabric";

/** A public link to a profile the owner maintains elsewhere, such as GitHub,
 * LinkedIn, or a personal site. Links are deliberately data, not profile
 * elements: unlike an element, an external link does not create or reference a
 * Common Fabric piece. */
export type ExternalProfileLink = {
  label: string;
  url: string;
};

/**
 * An external account identifier observed by Loom after that connector
 * successfully authenticated as the profile owner. Stable and human-facing
 * identifiers are separate assertions (for example `github.node_id` and
 * `github.login`) so consumers can use either without weakening provenance.
 *
 * Keep this tuple deliberately small: the integrity label covers the identity
 * type, value, and observation time together. Connector/provider metadata that
 * is not part of the assertion belongs in the writer event, not this record.
 */
export type ExternalIdentityAssertion = {
  type: string;
  value: string;
  verifiedAt: string;
};

export const LOOM_VERIFIED_EXTERNAL_IDENTITY_INTEGRITY =
  "loom-verified-external-identity" as const;

export type VerifiedExternalIdentity = RequiresIntegrity<
  ExternalIdentityAssertion,
  readonly [typeof LOOM_VERIFIED_EXTERNAL_IDENTITY_INTEGRITY]
>;

export type VerifiedExternalIdentityCell = Cell<VerifiedExternalIdentity>;
