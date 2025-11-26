import { Identity } from "@commontools/identity";
import { AppView, isAppView } from "./view.ts";

export type Command =
  | { type: "set-view"; view: AppView }
  | { type: "set-identity"; identity: Identity }
  | { type: "clear-authentication" }
  | { type: "set-show-charm-list-view"; show: boolean }
  | { type: "set-show-debugger-view"; show: boolean }
  | { type: "set-show-quick-jump-view"; show: boolean }
  | { type: "set-show-sidebar"; show: boolean }
  | { type: "toggle-favorite"; charmId: string };

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
    case "set-view": {
      return "view" in value && isAppView(value.view);
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
    case "set-show-sidebar": {
      return "show" in value && typeof value.show === "boolean";
    }
    case "toggle-favorite": {
      return "charmId" in value && typeof value.charmId === "string";
    }
  }
  return false;
}
