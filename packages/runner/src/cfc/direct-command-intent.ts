import type { Runtime } from "../runtime.ts";
import type {
  IExtendedStorageTransaction,
  MemorySpace,
} from "../storage/interface.ts";
import { matchesCfcAtomPattern } from "./atom-patterns.ts";
import type { CfcEventEnvelope } from "./event-envelope.ts";
import type { CfcIntentEventPayload } from "./intent-event.ts";
import {
  type CfcIntentOnce,
  type CreateCfcIntentOnceOptions,
  refineCfcIntentEventOnce,
} from "./intent-refinement.ts";

export interface RefineCfcDirectCommandIntentOptions<T>
  extends CreateCfcIntentOnceOptions<T> {
  readonly actingUser: string;
  readonly kernelName: string;
  readonly requiredSurface?: string;
}

function hasIntegrityAtom(
  integrity: readonly unknown[],
  pattern: Record<string, unknown>,
): boolean {
  return integrity.some((atom) =>
    matchesCfcAtomPattern(atom as never, pattern as never)
  );
}

export function canRefineCfcDirectCommandIntent(
  sourceIntent: Pick<CfcEventEnvelope<CfcIntentEventPayload>, "integrity">,
  options: Pick<
    RefineCfcDirectCommandIntentOptions<unknown>,
    "actingUser" | "kernelName" | "requiredSurface"
  >,
): boolean {
  const surfacePattern = options.requiredSurface === undefined
    ? {}
    : { surface: options.requiredSurface };

  return hasIntegrityAtom(sourceIntent.integrity, {
    type: "https://commonfabric.org/cfc/atom/UserSurfaceInput",
    user: options.actingUser,
    ...surfacePattern,
  }) &&
    hasIntegrityAtom(sourceIntent.integrity, {
      type: "https://commonfabric.org/cfc/atom/PromptSlotBound",
      role: "direct-command",
      kernelName: options.kernelName,
      subject: options.actingUser,
      ...surfacePattern,
    }) &&
    hasIntegrityAtom(sourceIntent.integrity, {
      type: "https://commonfabric.org/cfc/atom/Builtin",
      name: options.kernelName,
    });
}

export function refineCfcDirectCommandIntentOnce<T>(
  runtime: Runtime,
  tx: IExtendedStorageTransaction,
  space: MemorySpace,
  sourceIntent: CfcEventEnvelope<CfcIntentEventPayload>,
  options: RefineCfcDirectCommandIntentOptions<T>,
): CfcIntentOnce<T> | null {
  if (
    !canRefineCfcDirectCommandIntent(sourceIntent, {
      actingUser: options.actingUser,
      kernelName: options.kernelName,
      requiredSurface: options.requiredSurface,
    })
  ) {
    return null;
  }

  return refineCfcIntentEventOnce(runtime, tx, space, sourceIntent, options);
}
