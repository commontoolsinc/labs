export type CfcEventDeliveryMode = "default" | "once-per-handler";

export interface CfcEventEnvelope<T = unknown> {
  readonly id: string;
  readonly payload: T;
  readonly integrity: readonly unknown[];
  readonly delivery: CfcEventDeliveryMode;
  readonly sourceGestureId?: string;
  readonly evidence?: Record<string, unknown>;
}

export interface CreateCfcEventEnvelopeOptions<T> {
  readonly id: string;
  readonly payload: T;
  readonly integrity?: readonly unknown[];
  readonly delivery?: CfcEventDeliveryMode;
  readonly sourceGestureId?: string;
  readonly evidence?: Record<string, unknown>;
}

export function createCfcEventEnvelope<T>(
  options: CreateCfcEventEnvelopeOptions<T>,
): CfcEventEnvelope<T> {
  return {
    id: options.id,
    payload: options.payload,
    integrity: options.integrity ?? [],
    delivery: options.delivery ?? "default",
    sourceGestureId: options.sourceGestureId,
    evidence: options.evidence,
  };
}

export function isCfcEventEnvelope(
  value: unknown,
): value is CfcEventEnvelope<unknown> {
  if (!value || typeof value !== "object") {
    return false;
  }

  const maybeEnvelope = value as Partial<CfcEventEnvelope<unknown>>;
  return typeof maybeEnvelope.id === "string" &&
    "payload" in maybeEnvelope &&
    Array.isArray(maybeEnvelope.integrity) &&
    (maybeEnvelope.delivery === "default" ||
      maybeEnvelope.delivery === "once-per-handler");
}

export function normalizeCfcEventEnvelope(
  event: unknown,
): CfcEventEnvelope<unknown> {
  if (isCfcEventEnvelope(event)) {
    return event;
  }

  return createCfcEventEnvelope({
    id: crypto.randomUUID(),
    payload: event,
  });
}
