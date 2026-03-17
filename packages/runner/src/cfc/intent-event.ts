import { canonicalHash } from "@commontools/memory/canonical-hash";
import { storableFromNativeValue } from "@commontools/memory/storable-value";
import {
  type CfcEventDeliveryMode,
  type CfcEventEnvelope,
  createCfcEventEnvelope,
} from "./event-envelope.ts";
import { toHex } from "./shared.ts";

export interface CfcIntentEventPayload {
  readonly action: string;
  readonly conditionHash: string;
  readonly parameters: Record<string, unknown>;
}

export interface DeriveCfcIntentEventIdOptions {
  readonly sourceGestureId: string;
  readonly conditionHash: string;
  readonly parameters: Record<string, unknown>;
}

export interface CreateCfcIntentEventEnvelopeOptions
  extends DeriveCfcIntentEventIdOptions {
  readonly action: string;
  readonly evidence?: Record<string, unknown>;
  readonly integrity?: readonly unknown[];
  readonly delivery?: CfcEventDeliveryMode;
}

export function deriveCfcIntentEventId(
  options: DeriveCfcIntentEventIdOptions,
): string {
  const hash = canonicalHash(
    storableFromNativeValue({
      sourceGestureId: options.sourceGestureId,
      conditionHash: options.conditionHash,
      parameters: options.parameters,
    }),
  );
  return `cfc:intent:${toHex(hash.hash)}`;
}

export function createCfcIntentEventEnvelope(
  options: CreateCfcIntentEventEnvelopeOptions,
): CfcEventEnvelope<CfcIntentEventPayload> {
  return createCfcEventEnvelope({
    id: deriveCfcIntentEventId(options),
    payload: {
      action: options.action,
      conditionHash: options.conditionHash,
      parameters: options.parameters,
    },
    sourceGestureId: options.sourceGestureId,
    evidence: options.evidence,
    integrity: options.integrity,
    delivery: options.delivery ?? "once-per-handler",
  });
}
