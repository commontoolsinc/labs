import { Identity } from "@commontools/identity";
import { Command } from "../commands.ts";
import { CharmManager } from "@commontools/charm";
import { createCharmManager } from "../runtime.ts";

// Primary application state.
export interface AppState {
  identity?: Identity;
  spaceName?: string;
  charmManager?: CharmManager;
  activeCharmId?: string;
  apiUrl: URL;
}

export function clone(state: AppState): AppState {
  return Object.assign({}, state);
}

export async function applyCommand(
  state: AppState,
  command: Command,
): Promise<AppState> {
  const next = clone(state);
  switch (command.type) {
    case "set-active-charm-id": {
      next.activeCharmId = command.charmId;
      break;
    }
    case "set-identity": {
      next.identity = command.identity;
      next.charmManager = undefined;
      break;
    }
    case "set-space": {
      next.spaceName = command.spaceName;
      next.charmManager = undefined;
      break;
    }
  }
  // CharmManager is derived from `identity` and `spaceName`.
  // Ensure that the manager exists if both identity and spaceName
  // are provided.
  if (next.spaceName && next.identity && !next.charmManager) {
    next.charmManager = await createCharmManager({
      identity: next.identity,
      spaceName: next.spaceName,
      apiUrl: next.apiUrl,
    });
  }
  return next;
}
