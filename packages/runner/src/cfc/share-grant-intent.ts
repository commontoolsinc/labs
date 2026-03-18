import type { StorableObject } from "@commontools/memory/interface";
import { matchesCfcAtomPattern } from "./atom-patterns.ts";
import type { CfcEventEnvelope } from "./event-envelope.ts";
import type { CfcIntentEventPayload } from "./intent-event.ts";

export interface CfcShareGrant extends StorableObject {
  readonly kind: "ShareGrant";
  readonly owner: string;
  readonly resourceRef: string;
  readonly recipient: string;
  readonly scope: "read";
  readonly grantedAt: number;
  readonly sourceIntentId: string;
}

export interface CfcShareGrantPolicyKey extends StorableObject {
  readonly kind: "ShareGrant";
  readonly owner: string;
  readonly resourceRef: string;
  readonly recipient: string;
  readonly scope: "read";
}

export interface DeriveCfcShareGrantFromIntentOptions {
  readonly owner: string;
  readonly resourceRef: string;
  readonly recipient: string;
  readonly scope: "read";
  readonly grantedAt: number;
}

function hasIntegrityAtom(
  integrity: readonly unknown[],
  pattern: Record<string, unknown>,
): boolean {
  return integrity.some((atom) =>
    matchesCfcAtomPattern(atom as never, pattern as never)
  );
}

export function canDeriveCfcShareGrantFromIntent(
  sourceIntent: Pick<
    CfcEventEnvelope<CfcIntentEventPayload>,
    "payload" | "integrity"
  >,
  options: Omit<DeriveCfcShareGrantFromIntentOptions, "grantedAt">,
): boolean {
  const parameters = sourceIntent.payload.parameters;

  return sourceIntent.payload.action === "ShareWithUser" &&
    parameters.owner === options.owner &&
    parameters.resourceRef === options.resourceRef &&
    parameters.recipient === options.recipient &&
    parameters.scope === options.scope &&
    hasIntegrityAtom(sourceIntent.integrity, {
      type: "https://commonfabric.org/cfc/atom/GestureProvenance",
    }) &&
    hasIntegrityAtom(sourceIntent.integrity, {
      type: "https://commonfabric.org/cfc/atom/IntentSurfaceTrusted",
      action: "ShareWithUser",
    }) &&
    hasIntegrityAtom(sourceIntent.integrity, {
      type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
      kind: "SelectionInfluence",
      resourceRef: options.resourceRef,
      recipient: options.recipient,
    }) &&
    hasIntegrityAtom(sourceIntent.integrity, {
      type: "https://commonfabric.org/cfc/atom/DisclosureRendered",
      kind: "SelectionNotShared",
      resourceRef: options.resourceRef,
      recipient: options.recipient,
    });
}

export function deriveCfcShareGrantFromIntent(
  sourceIntent: Pick<
    CfcEventEnvelope<CfcIntentEventPayload>,
    "id" | "payload" | "integrity"
  >,
  options: DeriveCfcShareGrantFromIntentOptions,
): CfcShareGrant | null {
  if (
    !canDeriveCfcShareGrantFromIntent(sourceIntent, {
      owner: options.owner,
      resourceRef: options.resourceRef,
      recipient: options.recipient,
      scope: options.scope,
    })
  ) {
    return null;
  }

  return {
    kind: "ShareGrant",
    owner: options.owner,
    resourceRef: options.resourceRef,
    recipient: options.recipient,
    scope: options.scope,
    grantedAt: options.grantedAt,
    sourceIntentId: sourceIntent.id,
  };
}

export function deriveCfcShareGrantPolicyKey(
  grant: Pick<
    CfcShareGrant,
    "kind" | "owner" | "resourceRef" | "recipient" | "scope"
  >,
): CfcShareGrantPolicyKey {
  return {
    kind: "ShareGrant",
    owner: grant.owner,
    resourceRef: grant.resourceRef,
    recipient: grant.recipient,
    scope: grant.scope,
  };
}
