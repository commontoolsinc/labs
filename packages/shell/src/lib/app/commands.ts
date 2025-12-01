import { Identity } from "@commontools/identity";
import { AppView, isAppView } from "./view.ts";
import { AppStateConfigKey } from "./state.ts";

export type Command =
  | { type: "set-view"; view: AppView }
  | { type: "set-identity"; identity: Identity | undefined }
  | { type: "set-config"; key: AppStateConfigKey; value: boolean };

export function isCommand(value: unknown): value is Command {
  if (
    !value || typeof value !== "object" || !("type" in value) ||
    typeof value.type !== "string"
  ) {
    return false;
  }
  switch (value.type) {
    case "set-identity": {
      return "identity" in value &&
        (value.identity === undefined || value.identity instanceof Identity);
    }
    case "set-view": {
      return "view" in value && isAppView(value.view);
    }
    case "set-config": {
      return "key" in value && typeof value.key === "string" &&
        "value" in value && typeof value.value === "boolean";
    }
  }
  return false;
}
