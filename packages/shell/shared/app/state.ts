import {
  deserializeKeyPairRaw,
  Identity,
  serializeKeyPairRaw,
  TransferrableInsecureCryptoKeyPair,
} from "@commontools/identity";
import { Command } from "./commands.ts";
import { AppView } from "./view.ts";

// Primary application state.
export interface AppState {
  identity?: Identity;
  view: AppView;
  apiUrl: URL;
  config: AppStateConfig;
}

export interface AppStateConfig {
  showShellPieceListView?: boolean;
  showDebuggerView?: boolean;
  showQuickJumpView?: boolean;
  showSidebar?: boolean;
}

export type AppStateConfigKey = keyof AppStateConfig;

export type AppStateSerialized = Omit<AppState, "identity" | "apiUrl"> & {
  identity?: TransferrableInsecureCryptoKeyPair | null;
  apiUrl: string;
};

export function isAppStateConfigKey(
  value: unknown,
): value is AppStateConfigKey {
  if (typeof value !== "string") return false;
  switch (value) {
    case "showShellPieceListView":
    case "showDebuggerView":
    case "showQuickJumpView":
    case "showSidebar":
      return true;
  }
  return false;
}

export function createAppState(
  initial: Pick<AppState, "view" | "apiUrl" | "identity"> & {
    config?: AppStateConfig;
  },
): AppState {
  return Object.assign({}, initial, { config: initial.config ?? {} });
}

export function clone(state: AppState): AppState {
  return Object.assign({}, state, {
    config: Object.assign({}, state.config),
    view: typeof state.view === "object"
      ? Object.assign({}, state.view)
      : state.view,
  });
}

export function applyCommand(
  state: AppState,
  command: Command,
): AppState {
  const next = clone(state);
  switch (command.type) {
    case "set-identity": {
      next.identity = command.identity;
      break;
    }
    case "set-view": {
      next.view = command.view;
      if ("pieceId" in command.view && command.view.pieceId) {
        next.config.showShellPieceListView = false;
      }
      break;
    }
    case "set-config": {
      if (!isAppStateConfigKey(command.key)) {
        throw new Error(`Invalid config key: ${command.key}`);
      }
      next.config[command.key] = command.value;
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
  out.apiUrl = apiUrl.toString();
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
  out.apiUrl = new URL(apiUrl);
  return out;
}
