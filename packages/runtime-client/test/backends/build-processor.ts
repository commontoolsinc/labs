/**
 * A `RuntimeProcessor` built over stand-ins, for a test that drives one
 * handler at a time. It goes through the constructor the class keeps to
 * itself, so that what a test gets is a real instance, and what a test does
 * not supply is inert: an empty object where a handler never touches the
 * collaborator, a fresh telemetry hub, and a signer minted for these tests.
 */

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime, RuntimeTelemetry } from "@commonfabric/runner";
import { RuntimeProcessor } from "@/backends/runtime-processor.ts";

/** The signer a processor acts as when a test supplies no identity. */
export const standInSigner = await Identity.fromPassphrase(
  "runtime-processor-stand-in",
);

/**
 * Builds a processor over `parts`. Each part is declared as what the class
 * holds where it is handed over; `cc` is the piece context of `space`, the
 * home space, which is where a handler naming that space finds it.
 */
export function buildProcessor(parts: {
  runtime?: unknown;
  cc?: unknown;
  space?: MemorySpace;
  identity?: unknown;
  telemetry?: RuntimeTelemetry;
} = {}): RuntimeProcessor {
  const space = parts.space ?? standInSigner.did();
  return RuntimeProcessor.accessForTestingOnly.construct(
    (parts.runtime ?? {}) as Runtime,
    (parts.cc ?? {}) as PiecesController,
    space,
    (parts.identity ?? standInSigner) as Identity,
    parts.telemetry ?? new RuntimeTelemetry(),
    {
      identity: standInSigner.did(),
      apiUrl: "http://localhost/",
      spaceDid: space,
    },
  );
}
