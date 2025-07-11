export const AUTH_METHOD_PASSKEY = "passkey" as const;
export const AUTH_METHOD_PASSPHRASE = "passphrase" as const;

export type AuthMethod =
  | typeof AUTH_METHOD_PASSKEY
  | typeof AUTH_METHOD_PASSPHRASE;

export interface StoredCredential {
  id: string;
  method: AuthMethod;
}

export function getStoredCredential(): StoredCredential | null {
  const stored = localStorage.getItem("storedCredential");
  return stored ? JSON.parse(stored) : null;
}

export function saveCredential(credential: StoredCredential): void {
  localStorage.setItem("storedCredential", JSON.stringify(credential));
}

export function clearStoredCredential(): void {
  localStorage.removeItem("storedCredential");
}

export function createPasskeyCredential(id: string): StoredCredential {
  return {
    id,
    method: "passkey",
  };
}

export function createPassphraseCredential(): StoredCredential {
  return {
    id: crypto.randomUUID(),
    method: "passphrase",
  };
}

function base64urlToBase64(base64url: string): string {
  // Replace base64url specific chars with base64 chars
  let base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");

  // Add padding if necessary
  const padding = base64.length % 4;
  if (padding) {
    base64 += "=".repeat(4 - padding);
  }

  return base64;
}

export function getPublicKeyCredentialDescriptor(
  storedCredential: StoredCredential | null,
): PublicKeyCredentialDescriptor | undefined {
  if (storedCredential?.method === "passkey") {
    // Convert base64url to base64 before decoding
    const base64 = base64urlToBase64(storedCredential.id);
    return {
      id: Uint8Array.from(atob(base64), (c) => c.charCodeAt(0)),
      type: "public-key" as PublicKeyCredentialType,
    };
  }
  return undefined;
}
