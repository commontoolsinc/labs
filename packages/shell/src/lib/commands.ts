import { Identity, KeyStore } from "@commontools/identity";
import { Session } from "./app/state.ts";

export type Command =
  | { type: "set-active-charm-id"; charmId: string }
  | { type: "set-identity"; identity: Identity }
  | { type: "set-space"; spaceName: string }
  | { type: "set-keystore"; keyStore: KeyStore }
  | { type: "set-session"; session: Session }
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
    case "set-keystore": {
      return "keyStore" in value && value.keyStore instanceof KeyStore;
    }
    case "set-session": {
      return "session" in value && typeof value.session === "object";
    }
    case "clear-authentication": {
      return true;
    }
  }
  return false;
}
