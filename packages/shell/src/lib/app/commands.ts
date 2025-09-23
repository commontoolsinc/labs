import { Identity } from "@commontools/identity";

export type Command =
  | { type: "set-active-charm-id"; charmId?: string }
  | { type: "set-identity"; identity: Identity }
  | { type: "set-space"; spaceName: string }
  | { type: "clear-authentication" }
  | { type: "set-show-charm-list-view"; show: boolean }
  | { type: "set-show-debugger-view"; show: boolean }
  | { type: "set-show-quick-jump-view"; show: boolean };

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
        (typeof value.charmId === "string" || value.charmId === undefined);
    }
    case "clear-authentication": {
      return true;
    }
    case "set-show-charm-list-view": {
      return "show" in value && typeof value.show === "boolean";
    }
    case "set-show-debugger-view": {
      return "show" in value && typeof value.show === "boolean";
    }
    case "set-show-quick-jump-view": {
      return "show" in value && typeof value.show === "boolean";
    }
  }
  return false;
}
