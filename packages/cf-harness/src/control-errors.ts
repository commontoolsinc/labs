/** Stable failure codes exposed at cf-harness control boundaries. */
export type HarnessControlErrorCode =
  | "invalid-request"
  | "provider-configuration-required"
  | "provider-auth-required"
  | "provider-mismatch"
  | "provider-unavailable"
  | "internal-error"
  | "operation-canceled";

/** A machine-classifiable, bounded failure safe to return at host boundaries. */
export class HarnessControlError extends Error {
  constructor(
    readonly code: HarnessControlErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HarnessControlError";
  }
}
