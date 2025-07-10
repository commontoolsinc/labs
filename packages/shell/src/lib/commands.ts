import { Identity, KeyStore, PassKey } from "@commontools/identity";
import { Session } from "./app/state.ts";

export type Command =
  | { type: "set-active-charm-id"; charmId: string }
  | { type: "set-identity"; identity: Identity }
  | { type: "set-space"; spaceName: string }
  | { type: "set-keystore"; keyStore: KeyStore }
  | { type: "set-session"; session: Session }
  | { type: "passkey-register"; name: string; displayName: string }
  | { type: "passkey-authenticate"; descriptor?: PublicKeyCredentialDescriptor }
  | { type: "passphrase-register" }
  | { type: "passphrase-display-mnemonic"; mnemonic: string }
  | { type: "passphrase-authenticate"; mnemonic: string }
  | { type: "clear-authentication" };

export function isCommand(value: unknown): value is Command {
  if (
    !value || typeof value !== "object" || !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  switch (value.type) {
    case "set-identity": {
      return "identity" in value && value.identity instanceof Identity;
    }
    case "set-space": {
      return "spaceName" in value && !!value.spaceName &&
        typeof value.spaceName === "string";
    }
    case "set-active-charm-id": {
      return "charmId" in value && !!value.charmId &&
        typeof value.charmId === "string";
    }
    // ========================================================================
    // Authentication commands
    // ========================================================================
    case "set-keystore": {
      return "keyStore" in value && value.keyStore instanceof KeyStore;
    }
    case "set-session": {
      return "session" in value && typeof value.session === "object";
    }
    case "passkey-register": {
      return "name" in value && typeof value.name === "string" &&
        "displayName" in value && typeof value.displayName === "string";
    }
    case "passkey-authenticate": {
      return true;
    }
    case "passphrase-register": {
      return true;
    }
    case "passphrase-display-mnemonic": {
      return "mnemonic" in value && typeof value.mnemonic === "string";
    }
    case "passphrase-authenticate": {
      return "mnemonic" in value && typeof value.mnemonic === "string";
    }
    case "clear-authentication": {
      return true;
    }
  }
  return false;
}
