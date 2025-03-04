export const createEd25519Key = async (): CryptoKey => {
  const dummyKey = new Uint8Array(32);

  return await globalThis.crypto.subtle.importKey(
    "raw",
    dummyKey,
    "ed25519",
    false,
    ["verify"],
  );
};
