/**
 * Trusted-UI event synthesis for pattern tests.
 *
 * Writes guarded by a `TrustedActionWrite`/`TrustedActionUiContract` policy
 * require a renderer-trusted event whose DOM provenance matches the surface's
 * UI contract. In production the html worker reconciler attaches that
 * provenance and marks the event when a real DOM event fires on a trusted
 * surface. Pattern tests have no renderer, so the test runner — host code,
 * standing in for the user's gesture exactly like the renderer does — builds
 * the equivalent event for steps that declare a `trustedUi` descriptor.
 *
 * Mirrors `packages/patterns/integration/multi-runtime-worker.ts` (the
 * multi-runtime browser-parity harness) and the provenance shape produced by
 * `packages/html/src/worker/reconciler.ts`.
 */

import {
  markRendererTrustedEvent,
  markRuntimeInjectedEventKeys,
} from "@commonfabric/runner/cfc";

export interface TrustedUiDescriptor {
  /** `data-ui-pattern` / `data-ui-event-integrity` of the trusted surface. */
  surface: string;
  /** `data-ui-action` of the control inside the surface. */
  action: string;
}

export const isTrustedUiDescriptor = (
  value: unknown,
): value is TrustedUiDescriptor =>
  typeof value === "object" && value !== null &&
  typeof (value as { surface?: unknown }).surface === "string" &&
  typeof (value as { action?: unknown }).action === "string";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** An action step's event value together with the send options it needs. */
export interface ActionEvent {
  /** The value to hand `stream.send`. */
  value: unknown;
  /**
   * Send options naming the keys this runner injected, so a verb's closed
   * event schema judges only what the step itself supplied. Names nothing
   * when the step's payload passes through untouched.
   */
  sendOptions: { runtimeInjectedEventKeys?: readonly string[] };
}

/**
 * Resolve the event value to send for an action step: the step's literal
 * `event` payload (if any), wrapped with trusted DOM provenance and the
 * renderer-trusted mark when a `trustedUi` descriptor is present.
 *
 * A trusted gesture without a payload sends `{ type: "click" }` (renderer
 * parity). An explicit record payload keeps every field the step authored —
 * handlers may branch on fields like `type`, so none are overwritten.
 *
 * The wrapper's own fields are declared as runtime-injected, the same way the
 * renderer declares the envelope it builds around a real gesture: `provenance`
 * always, and the synthesized `type` when the step supplied no payload to take
 * it from. A step's own fields are never declared — an undeclared one is the
 * step's mistake, and the verb's closed event schema must still catch it.
 */
export function buildActionEvent(
  event: unknown,
  trustedUi: unknown,
): ActionEvent {
  if (!isTrustedUiDescriptor(trustedUi)) {
    return { value: event, sendOptions: {} };
  }
  const authored = isRecord(event) ? event : undefined;
  const eventValue = {
    ...(authored ?? { type: "click" }),
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: trustedUi.surface,
        eventIntegrity: [trustedUi.surface],
        uiContractDataset: { uiAction: trustedUi.action },
      },
    },
  };
  markRendererTrustedEvent(eventValue);
  return {
    value: eventValue,
    sendOptions: {
      runtimeInjectedEventKeys: markRuntimeInjectedEventKeys(
        authored ? ["provenance"] : ["type", "provenance"],
      ),
    },
  };
}
