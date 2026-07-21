export { PassKey } from "./pass-key.ts";
export {
  Identity,
  type IdentityCreateConfig,
  VerifierIdentity,
} from "./identity.ts";
export { KeyStore } from "./key-store.ts";
// PKCS8/PEM <-> raw-seed helpers. Exported from the root because downstream
// consumers otherwise deep-import `./ed25519/utils.ts` by file path, which is
// brittle across version bumps (Loom's pairing-phrase CLI does exactly that
// today and can drop it once this ships).
export { fromPEM, pkcs8ToEd25519Raw, toPEM } from "./ed25519/utils.ts";
export * from "./interface.ts";
export { createSession, type Session } from "./session.ts";
