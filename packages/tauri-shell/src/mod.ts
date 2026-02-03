/**
 * @module @commontools/tauri-shell
 *
 * Tauri mobile app wrapper for Common Tools Shell with native passkey integration.
 *
 * This module provides:
 * - Native passkey support for Android (Credential Manager API) and iOS (ASAuthorizationController)
 * - Automatic fallback to WebAuthn for desktop/browser environments
 * - Unified TypeScript API for passkey operations
 *
 * @example
 * ```typescript
 * import { isTauri, isPasskeyAvailable, createPasskey, getPasskey } from "@commontools/tauri-shell";
 *
 * // Check if running in Tauri
 * if (isTauri()) {
 *   console.log("Running in Tauri mobile app");
 * }
 *
 * // Check passkey availability
 * const available = await isPasskeyAvailable();
 * if (available) {
 *   // Create a new passkey
 *   const credential = await createPasskey({
 *     rpName: "Common Tools",
 *     userId: "user123",
 *     userName: "user@example.com",
 *     userDisplayName: "John Doe",
 *     challenge: "base64url-encoded-challenge",
 *   });
 * }
 * ```
 */

export {
  isTauri,
  isPasskeyAvailable,
  createPasskey,
  getPasskey,
  getPasskeyAssertion,
  type CreatePasskeyOptions,
  type GetPasskeyOptions,
  type PasskeyCreationResult,
  type PasskeyAssertionResult,
  type PasskeyExtensions,
} from "./passkey-bridge.ts";
