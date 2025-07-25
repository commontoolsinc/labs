import { Identity } from "@commontools/identity";
import { Command } from "./commands.ts";

// Primary application state.
export interface AppState {
  identity?: Identity;
  spaceName?: string;
  activeCharmId?: string;
  apiUrl: URL;
  showShellCharmListView?: boolean;
  showInspectorView?: boolean;
}

export function clone(state: AppState): AppState {
  return Object.assign({}, state);
}

export function applyCommand(
  state: AppState,
  command: Command,
): AppState {
  const next = clone(state);
  switch (command.type) {
    case "set-active-charm-id": {
      next.activeCharmId = command.charmId;
      break;
    }
    case "set-identity": {
      next.identity = command.identity;
      break;
    }
    case "set-space": {
      next.spaceName = command.spaceName;
      break;
    }
    case "clear-authentication": {
      next.identity = undefined;
      break;
    }
    case "set-show-charm-list-view": {
      next.showShellCharmListView = command.show;
      break;
    }
    case "set-show-inspector-view": {
      next.showInspectorView = command.show;
      break;
    }
  }

  return next;
}
