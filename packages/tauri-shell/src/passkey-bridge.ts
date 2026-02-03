/**
 * Passkey Bridge for Tauri Mobile Apps
 *
 * This module provides a unified interface for passkey operations that:
 * - Uses native platform APIs (Android Credential Manager, iOS ASAuthorizationController) when running in Tauri
 * - Falls back to standard WebAuthn API when running in a browser
 *
 * The bridge automatically detects the runtime environment and uses the appropriate implementation.
 */

// Type declarations for Tauri's invoke API
declare global {
  interface Window {
    __TAURI__?: {
      core: {
        invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
      };
    };
  }
}

/**
 * Check if we're running inside a Tauri application
 */
export function isTauri(): boolean {
  return typeof window !== "undefined" && window.__TAURI__ !== undefined;
}

/**
 * Check if passkeys are available on this device
 */
export async function isPasskeyAvailable(): Promise<boolean> {
  if (isTauri()) {
    try {
      return await window.__TAURI__!.core.invoke<boolean>("is_passkey_available");
    } catch (error) {
      console.error("Failed to check passkey availability:", error);
      return false;
    }
  }

  // Browser fallback
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential !== "undefined" &&
    typeof window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable === "function"
  );
}

/**
 * Options for creating a passkey
 */
export interface CreatePasskeyOptions {
  rpId?: string;
  rpName: string;
  userId: string;
  userName: string;
  userDisplayName: string;
  challenge: string; // base64url encoded
  timeout?: number;
  attestation?: AttestationConveyancePreference;
  authenticatorSelection?: AuthenticatorSelectionCriteria;
  extensions?: PasskeyExtensions;
}

export interface PasskeyExtensions {
  prf?: {
    eval?: {
      first: ArrayBuffer | string;
      second?: ArrayBuffer | string;
    };
    evalByCredential?: Record<string, { first: ArrayBuffer | string; second?: ArrayBuffer | string }>;
  };
}

/**
 * Options for getting a passkey
 */
export interface GetPasskeyOptions {
  rpId?: string;
  challenge: string; // base64url encoded
  timeout?: number;
  userVerification?: UserVerificationRequirement;
  allowCredentials?: Array<{
    id: string; // base64url encoded
    type: "public-key";
    transports?: AuthenticatorTransport[];
  }>;
  extensions?: PasskeyExtensions;
}

/**
 * Result of passkey creation
 */
export interface PasskeyCreationResult {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: AuthenticatorAttachment;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    transports?: AuthenticatorTransport[];
    publicKey?: string;
    publicKeyAlgorithm?: number;
    authenticatorData?: string;
  };
  clientExtensionResults: {
    prf?: {
      enabled?: boolean;
      results?: {
        first: string;
        second?: string;
      };
    };
  };
}

/**
 * Result of passkey assertion
 */
export interface PasskeyAssertionResult {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: AuthenticatorAttachment;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
  clientExtensionResults: {
    prf?: {
      enabled?: boolean;
      results?: {
        first: string;
        second?: string;
      };
    };
  };
}

/**
 * Create a new passkey
 */
export async function createPasskey(
  options: CreatePasskeyOptions
): Promise<PasskeyCreationResult> {
  if (isTauri()) {
    return await window.__TAURI__!.core.invoke<PasskeyCreationResult>(
      "create_passkey",
      { options: convertToCamelCase(options) }
    );
  }

  // Browser WebAuthn fallback
  return await createPasskeyWebAuthn(options);
}

/**
 * Get an existing passkey for authentication
 */
export async function getPasskey(
  options: GetPasskeyOptions
): Promise<PasskeyAssertionResult> {
  if (isTauri()) {
    return await window.__TAURI__!.core.invoke<PasskeyAssertionResult>(
      "get_passkey",
      { options: convertToCamelCase(options) }
    );
  }

  // Browser WebAuthn fallback
  return await getPasskeyWebAuthn(options);
}

/**
 * Get a passkey assertion with PRF extension support
 */
export async function getPasskeyAssertion(
  options: GetPasskeyOptions
): Promise<PasskeyAssertionResult> {
  if (isTauri()) {
    return await window.__TAURI__!.core.invoke<PasskeyAssertionResult>(
      "get_passkey_assertion",
      { options: convertToCamelCase(options) }
    );
  }

  // Browser WebAuthn fallback
  return await getPasskeyWebAuthn(options);
}

// ============================================================================
// WebAuthn Browser Implementation
// ============================================================================

async function createPasskeyWebAuthn(
  options: CreatePasskeyOptions
): Promise<PasskeyCreationResult> {
  const challengeBytes = base64UrlDecode(options.challenge);
  const userIdBytes = base64UrlDecode(options.userId);

  const publicKeyOptions: PublicKeyCredentialCreationOptions = {
    challenge: challengeBytes.buffer as ArrayBuffer,
    rp: {
      id: options.rpId,
      name: options.rpName,
    },
    user: {
      id: userIdBytes.buffer as ArrayBuffer,
      name: options.userName,
      displayName: options.userDisplayName,
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -8 }, // Ed25519
      { type: "public-key", alg: -7 }, // ES256
      { type: "public-key", alg: -257 }, // RS256
    ],
    authenticatorSelection: options.authenticatorSelection ?? {
      authenticatorAttachment: "platform",
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    timeout: options.timeout ?? 60000,
    attestation: options.attestation ?? "none",
    extensions: options.extensions
      ? convertExtensionsForWebAuthn(options.extensions)
      : undefined,
  };

  const credential = (await navigator.credentials.create({
    publicKey: publicKeyOptions,
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error("Failed to create passkey");
  }

  const attestationResponse =
    credential.response as AuthenticatorAttestationResponse;

  return {
    id: credential.id,
    rawId: base64UrlEncode(new Uint8Array(credential.rawId)),
    type: "public-key",
    authenticatorAttachment: credential.authenticatorAttachment as AuthenticatorAttachment,
    response: {
      clientDataJSON: base64UrlEncode(
        new Uint8Array(attestationResponse.clientDataJSON)
      ),
      attestationObject: base64UrlEncode(
        new Uint8Array(attestationResponse.attestationObject)
      ),
      transports: attestationResponse.getTransports?.() as AuthenticatorTransport[],
      publicKey: attestationResponse.getPublicKey
        ? base64UrlEncode(new Uint8Array(attestationResponse.getPublicKey()!))
        : undefined,
      publicKeyAlgorithm: attestationResponse.getPublicKeyAlgorithm?.(),
      authenticatorData: attestationResponse.getAuthenticatorData
        ? base64UrlEncode(
            new Uint8Array(attestationResponse.getAuthenticatorData())
          )
        : undefined,
    },
    clientExtensionResults: convertExtensionResults(
      credential.getClientExtensionResults()
    ),
  };
}

async function getPasskeyWebAuthn(
  options: GetPasskeyOptions
): Promise<PasskeyAssertionResult> {
  const challengeBytes = base64UrlDecode(options.challenge);

  const publicKeyOptions: PublicKeyCredentialRequestOptions = {
    challenge: challengeBytes.buffer as ArrayBuffer,
    rpId: options.rpId,
    timeout: options.timeout ?? 60000,
    userVerification: options.userVerification ?? "required",
    allowCredentials: options.allowCredentials?.map((cred) => ({
      id: base64UrlDecode(cred.id).buffer as ArrayBuffer,
      type: cred.type,
      transports: cred.transports,
    })),
    extensions: options.extensions
      ? convertExtensionsForWebAuthn(options.extensions)
      : undefined,
  };

  const credential = (await navigator.credentials.get({
    publicKey: publicKeyOptions,
  })) as PublicKeyCredential;

  if (!credential) {
    throw new Error("Failed to get passkey");
  }

  const assertionResponse =
    credential.response as AuthenticatorAssertionResponse;

  return {
    id: credential.id,
    rawId: base64UrlEncode(new Uint8Array(credential.rawId)),
    type: "public-key",
    authenticatorAttachment: credential.authenticatorAttachment as AuthenticatorAttachment,
    response: {
      clientDataJSON: base64UrlEncode(
        new Uint8Array(assertionResponse.clientDataJSON)
      ),
      authenticatorData: base64UrlEncode(
        new Uint8Array(assertionResponse.authenticatorData)
      ),
      signature: base64UrlEncode(new Uint8Array(assertionResponse.signature)),
      userHandle: assertionResponse.userHandle
        ? base64UrlEncode(new Uint8Array(assertionResponse.userHandle))
        : undefined,
    },
    clientExtensionResults: convertExtensionResults(
      credential.getClientExtensionResults()
    ),
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function base64UrlEncode(bytes: Uint8Array): string {
  const base64 = btoa(String.fromCharCode(...bytes));
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  let base64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const padding = (4 - (base64.length % 4)) % 4;
  base64 += "=".repeat(padding);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function convertToCamelCase<T extends object>(obj: T): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    const camelKey = key.replace(/_([a-z])/g, (_, letter) =>
      letter.toUpperCase()
    );
    const value = (obj as Record<string, unknown>)[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      result[camelKey] = convertToCamelCase(value as object);
    } else {
      result[camelKey] = value;
    }
  }
  return result;
}

function convertExtensionsForWebAuthn(
  extensions: PasskeyExtensions
): AuthenticationExtensionsClientInputs {
  const result: AuthenticationExtensionsClientInputs = {};

  if (extensions.prf) {
    (result as any).prf = {
      eval: extensions.prf.eval
        ? {
            first:
              typeof extensions.prf.eval.first === "string"
                ? base64UrlDecode(extensions.prf.eval.first)
                : extensions.prf.eval.first,
            second: extensions.prf.eval.second
              ? typeof extensions.prf.eval.second === "string"
                ? base64UrlDecode(extensions.prf.eval.second)
                : extensions.prf.eval.second
              : undefined,
          }
        : undefined,
      evalByCredential: extensions.prf.evalByCredential,
    };
  }

  return result;
}

function convertExtensionResults(
  results: AuthenticationExtensionsClientOutputs
): PasskeyCreationResult["clientExtensionResults"] {
  const converted: PasskeyCreationResult["clientExtensionResults"] = {};

  const prfResults = (results as any).prf;
  if (prfResults) {
    converted.prf = {
      enabled: prfResults.enabled,
      results: prfResults.results
        ? {
            first:
              prfResults.results.first instanceof ArrayBuffer
                ? base64UrlEncode(new Uint8Array(prfResults.results.first))
                : prfResults.results.first,
            second: prfResults.results.second
              ? prfResults.results.second instanceof ArrayBuffer
                ? base64UrlEncode(new Uint8Array(prfResults.results.second))
                : prfResults.results.second
              : undefined,
          }
        : undefined,
    };
  }

  return converted;
}
