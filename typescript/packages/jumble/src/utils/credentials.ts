export interface StoredCredential {
  id: string;
  method: "passkey" | "passphrase";
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

export function getPublicKeyCredentialDescriptor(
  storedCredential: StoredCredential | null,
): PublicKeyCredentialDescriptor | undefined {
  if (storedCredential?.method === "passkey") {
    return {
      id: Uint8Array.from(atob(storedCredential.id), (c) => c.charCodeAt(0)),
      type: "public-key" as PublicKeyCredentialType,
    };
  }
  return undefined;
}
