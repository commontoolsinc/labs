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

import { markRendererTrustedEvent } from "@commonfabric/runner/cfc";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";

export interface TrustedUiDescriptor {
  /** `data-ui-pattern` / `data-ui-event-integrity` of the trusted surface. */
  surface: string;

  /** `data-ui-action` of the control inside the surface. */
  action: string;
}

export const isTrustedUiDescriptor = (
  value: unknown,
): value is TrustedUiDescriptor =>
  isObjectOrArray(value) &&
  typeof (value as { surface?: unknown }).surface === "string" &&
  typeof (value as { action?: unknown }).action === "string";

/**
 * Resolve the event value to send for an action step: the step's literal
 * `event` payload (if any), wrapped with trusted DOM provenance and the
 * renderer-trusted mark when a `trustedUi` descriptor is present.
 *
 * A trusted gesture without a payload sends `{ type: "click" }` (renderer
 * parity). An explicit record payload is sent exactly as authored — handlers
 * may branch on fields like `type`, so none are injected.
 */
export function buildActionEvent(
  event: unknown,
  trustedUi: unknown,
): unknown {
  if (!isTrustedUiDescriptor(trustedUi)) {
    return event;
  }
  const eventValue = {
    type: "click",
    ...(isObjectNotArray(event) ? event : {}),
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
  return eventValue;
}
