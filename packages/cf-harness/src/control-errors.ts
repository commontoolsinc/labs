/** Stable failure codes exposed at cf-harness control boundaries. */
export type HarnessControlErrorCode =
  | "provider-configuration-required"
  | "provider-auth-required"
  | "provider-mismatch"
  | "provider-unavailable"
  | "operation-canceled";

/**
 * A machine-classifiable provider failure whose message and cause graph are
 * safe to persist in run metadata or return from a control command.
 */
export class HarnessControlError extends Error {
  constructor(
    readonly code: HarnessControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HarnessControlError";
  }
}
