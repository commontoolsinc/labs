import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";
import { DID, Identity } from "@commonfabric/identity";
import { AppView } from "@commonfabric/navigation";

/**
 * An identity as it crosses the integration-test page boundary: its key pair
 * in the `FabricValue` JSON encoding. A string, that boundary carrying only
 * what JSON can express.
 */
export type SerializedIdentity = string;

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

// A config key names a field the display toggles record actually has. A
// `shell-command` event arrives as an untyped DOM event, so the key it carries
// is checked here before it reaches the record.
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

export type AppStateSerialized = Omit<AppState, "identity" | "apiUrl"> & {
  identity?: SerializedIdentity | null;
  apiUrl: string;
};

// The application root, as everything outside the root element sees it.
// `Navigation` reads and writes the view through this, and the shell publishes
// its root element on `globalThis.app` under this type so integration tests
// can drive the page from outside. `XRootView` implements it. Declaring it
// here keeps `Navigation` and the integration-test harness clear of the root
// element's import graph.
export interface ShellApp {
  state(): AppState;
  serialize(): AppStateSerialized;
  getRuntimeSpaceDID(): DID | undefined;
  setView(view: AppView): Promise<void>;
  setIdentity(
    id: Identity | SerializedIdentity | undefined,
  ): Promise<void>;
  setConfig(key: AppStateConfigKey, value: boolean): Promise<void>;
}

/**
 * Turns either form an identity arrives in — a live `Identity`, or the encoded
 * key pair that crosses the integration-test page boundary — into the
 * `Identity` application state holds.
 */
export async function resolveIdentity(
  id: Identity | SerializedIdentity | undefined,
): Promise<Identity | undefined> {
  if (id === undefined) return undefined;
  if (id instanceof Identity) return id;
  // From the seed rather than from the pair itself: this page picks its own
  // ed25519 implementation, as it does for every identity it mints.
  return await Identity.fromRaw(
    keyPairFromSerialized(id).privateKeyBytes.slice(),
  );
}

/**
 * Renders an identity as the page boundary carries it, or `null` where it
 * cannot be written down: a key pair holding handles has no JSON encoding,
 * `CryptoKey` material being unreachable.
 */
function serializeIdentity(
  identity: Identity | undefined,
): SerializedIdentity | null | undefined {
  if (identity === undefined) return undefined;
  const { keyPair } = identity;
  return keyPair.hasMaterial ? jsonFromFabricValue(keyPair) : null;
}

/**
 * Decodes what {@link serializeIdentity} produced.
 *
 * @throws If the encoding is well-formed and decodes to something other than a
 *   key pair.
 */
function keyPairFromSerialized(id: SerializedIdentity): FabricKeyPair {
  const keyPair = fabricFromJsonValue(id);

  if (!(keyPair instanceof FabricKeyPair)) {
    throw new Error("Serialized identity is not a key pair.");
  }

  return keyPair;
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
    view: Object.assign({}, state.view),
  });
}

export function serialize(
  state: AppState,
): AppStateSerialized {
  const { identity, apiUrl, ...other } = state;
  const out = other as unknown as AppStateSerialized;
  out.identity = serializeIdentity(identity);
  out.apiUrl = apiUrl.toString();
  return out;
}

export async function deserialize(
  state: AppStateSerialized,
): Promise<AppState> {
  const { identity, apiUrl, ...other } = state;
  const out = other as unknown as AppState;
  out.identity = identity ? await resolveIdentity(identity) : undefined;
  out.apiUrl = new URL(apiUrl);
  return out;
}
