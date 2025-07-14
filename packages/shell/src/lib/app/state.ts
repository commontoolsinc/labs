import {
  ANYONE,
  DID,
  Identity,
  KeyStore,
} from "@commontools/identity";
import { Command } from "../commands.ts";

// Representation of authorization session.
export interface Session {
  // Whether session is for a private space vs public access space.
  private: boolean;
  // Session name, which is pet name of the space session is for.
  name: string;
  // DID identifier of the space this is a session for.
  space: DID;
  // Identity used in this session.
  as: Identity;
}

// Primary application state.
export interface AppState {
  identity?: Identity;
  spaceName?: string;
  activeCharmId?: string;
  apiUrl: URL;
  keyStore?: KeyStore;
  session?: Session;
}

export function clone(state: AppState): AppState {
  return Object.assign({}, state);
}

// Key store key name for user's key
export const ROOT_KEY = "$ROOT_KEY";

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
    case "set-keystore": {
      next.keyStore = command.keyStore;
      break;
    }
    case "set-session": {
      next.session = command.session;
      break;
    }
    case "clear-authentication": {
      next.identity = undefined;
      next.session = undefined;
      break;
    }
  }

  return next;
}
