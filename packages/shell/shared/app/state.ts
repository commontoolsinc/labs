import {
  deserializeKeyPairRaw,
  DID,
  Identity,
  serializeKeyPairRaw,
  TransferrableInsecureCryptoKeyPair,
} from "@commonfabric/identity";
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

// The application root, as everything outside the root element sees it.
// `Navigation` reads and writes the view through this, and the shell publishes
// its root element on `globalThis.app` under this type so integration tests
// can drive the page from outside. `XRootView` implements it. Declaring it
// here keeps these shared sources, which the `ui` package compiles too, clear
// of the root element's import graph.
export interface ShellApp {
  state(): AppState;
  serialize(): AppStateSerialized;
  getRuntimeSpaceDID(): DID | undefined;
  setView(view: AppView): Promise<void>;
  setIdentity(
    id: Identity | TransferrableInsecureCryptoKeyPair | undefined,
  ): Promise<void>;
  setConfig(key: AppStateConfigKey, value: boolean): Promise<void>;
}

// Turns either form an identity arrives in — a live `Identity`, or the raw key
// pair that crosses the integration-test page boundary — into the `Identity`
// application state holds.
export async function resolveIdentity(
  id: Identity | TransferrableInsecureCryptoKeyPair | undefined,
): Promise<Identity | undefined> {
  if (id === undefined) return undefined;
  if (id instanceof Identity) return id;
  return await Identity.fromRaw(deserializeKeyPairRaw(id).privateKey);
}

// One identity replaces another only by way of a logged-out state. Clearing
// the identity is always allowed.
export function assertIdentityChangeAllowed(
  current: Identity | undefined,
  next: Identity | undefined,
): void {
  if (next && current && current.did() !== next.did()) {
    throw new Error(
      "Cannot change identity while logged in. Clear identity first.",
    );
  }
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
