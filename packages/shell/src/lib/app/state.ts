import {
  deserializeKeyPairRaw,
  Identity,
  serializeKeyPairRaw,
  TransferrableInsecureCryptoKeyPair,
} from "@commontools/identity";
import { Command } from "./commands.ts";

// Primary application state.
export interface AppState {
  identity?: Identity;
  spaceName?: string;
  activeCharmId?: string;
  apiUrl: URL;
  showShellCharmListView?: boolean;
  showDebuggerView?: boolean;
  showQuickJumpView?: boolean;
}

export type AppStateSerialized = Omit<AppState, "identity" | "apiUrl"> & {
  identity?: TransferrableInsecureCryptoKeyPair | null;
  apiUrl: string;
};

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
    case "set-show-debugger-view": {
      next.showDebuggerView = command.show;
      break;
    }
    case "set-show-quick-jump-view": {
      next.showQuickJumpView = command.show;
      break;
    }
  }

  return next;
}

export function serialize(
  state: AppState,
): AppStateSerialized {
  const { identity, apiUrl, ...other } = state;
  const out = other as unknown as AppStateSerialized;
  // Identity key serialization uses array buffers and webcrypto references
  // for JavaScript contexts. When serializing state here, its in service
  // of transferring to astral, JSONish boundaries. Convert the key to
  // buffers of `Array<number>`.
  out.identity = identity
    ? serializeKeyPairRaw(identity.serialize())
    : undefined;
  out.apiUrl = state.apiUrl.toString();
  return out;
}

export async function deserialize(
  state: AppStateSerialized,
): Promise<AppState> {
  const { identity, apiUrl, ...other } = state;
  const out = other as unknown as AppState;
  out.identity = identity
    ? await Identity.fromRaw(deserializeKeyPairRaw(identity).privateKey)
    : undefined;
  out.apiUrl = new URL(state.apiUrl);
  return out;
}
