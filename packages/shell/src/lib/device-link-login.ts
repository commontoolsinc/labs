import { Identity, KeyStore } from "@commonfabric/identity";
import { ROOT_KEY } from "../../shared/mod.ts";
import "../views/DeviceLinkView.ts";

// Orchestrates device-link login: entropy -> confirm -> KeyStore.
//
// ORDERING CONSTRAINT (do not deviate): this must overwrite ROOT_KEY in the
// KeyStore BEFORE the app's normal key initialization runs, then let the normal
// boot pick the new identity up. It must NOT route through App.setIdentity or a
// set-identity command — those THROW "Cannot change identity while logged in"
// when a different identity is active, and replacing a stale identity is the
// entire point of this handler.
//
// It also runs at BOOTSTRAP rather than from LoginView, because LoginView never
// mounts when a stale identity auto-logs in — which is exactly the re-pair case.
// A LoginView-only handler would silently no-op there.

/**
 * Result of an attempted device-link login.
 *
 * `accepted` and `already-signed-in` are DISTINCT on purpose: only `accepted`
 * changed the stored key. A caller re-running this while the app is already
 * booted (the hashchange path) needs that difference to decide whether to
 * reload — reloading on a no-op write would be a pointless flash.
 */
export type DeviceLinkOutcome =
  | "accepted"
  | "already-signed-in"
  | "cancelled"
  | "invalid";

/** Why a scan could not complete — drives the failure screen's copy. */
export type DeviceLinkFailure = "unreadable" | "failed";

export async function confirmWithUser(
  incomingDid: string,
  currentDid: string | null,
): Promise<boolean> {
  const view = document.createElement("x-device-link-view");
  view.incomingDid = incomingDid;
  view.currentDid = currentDid;
  // Listen BEFORE inserting. Nothing can dispatch in between today (the
  // Promise executor is synchronous and Lit's first update is a microtask),
  // but relying on that is accidental rather than defended.
  const answered = new Promise<boolean>((resolve) => {
    view.addEventListener(
      "device-link-result",
      (event) => resolve(Boolean((event as CustomEvent).detail?.accepted)),
      { once: true },
    );
  });
  document.body.appendChild(view);
  try {
    return await answered;
  } finally {
    view.remove();
  }
}

/**
 * Tell the user a scan failed, and why they cannot simply retry the same URL.
 *
 * Reuses the confirm view's shape with no accept path — the point is only that
 * a failed scan is never silent. Without this, an undecodable payload (or a
 * mid-flow error) boots to an ordinary login screen and looks like the scan
 * never happened, while the scrub has already made "refresh once and rescan"
 * impossible.
 */
export async function reportDeviceLinkFailure(
  reason: DeviceLinkFailure,
): Promise<void> {
  const view = document.createElement("x-device-link-view");
  view.failure = reason;
  const dismissed = new Promise<void>((resolve) => {
    view.addEventListener("device-link-result", () => resolve(), {
      once: true,
    });
  });
  document.body.appendChild(view);
  try {
    await dismissed;
  } finally {
    view.remove();
  }
}

/**
 * Derive the identity a device link names, confirm with the user, and store it.
 *
 * Returns without touching the KeyStore on cancel or on undecodable entropy,
 * so the normal boot continues with whatever session already existed.
 */
export async function runDeviceLinkLogin(
  entropy: Uint8Array,
  confirm: (
    incomingDid: string,
    currentDid: string | null,
  ) => Promise<boolean> = confirmWithUser,
  // Injected so the flow is testable off-browser: KeyStore is IndexedDB-backed
  // and `deno test` has no indexedDB, which would otherwise leave the
  // confirm/replace logic — the security-critical part — uncovered.
  // Narrowed to the two methods used, so a test double satisfies it without an
  // `any` cast (KeyStore has a private field, so the full type never can).
  openKeyStore: () => Promise<Pick<KeyStore, "get" | "set">> = () =>
    KeyStore.open(),
): Promise<DeviceLinkOutcome> {
  let identity: Identity;
  try {
    // `fromRaw`, not a bip39 round trip: BIP39 maps a phrase to entropy and
    // uses those bytes DIRECTLY as the ed25519 seed, with no KDF between, so
    // entropy IS the raw key. `identity.test.ts` pins that equivalence against
    // `fromMnemonic`, which is what keeps the shell and the pairing device
    // deriving the same DID. Throws on any length but 32.
    identity = await Identity.fromRaw(entropy);
  } catch {
    return "invalid";
  }

  const keyStore = await openKeyStore();
  const existing = await keyStore.get(ROOT_KEY);
  const currentDid = existing ? existing.did() : null;

  if (!await confirm(identity.did(), currentDid)) return "cancelled";

  // Already this identity: nothing to write, and rewriting would be a
  // needless churn of the stored key.
  if (currentDid === identity.did()) return "already-signed-in";

  await keyStore.set(ROOT_KEY, identity);
  // Deliberately NOT saveCredential(createPassphraseCredential()): that mints a
  // fresh UUID over `storedCredential`, and if this device had a passkey its
  // descriptor id is overwritten — quick-unlock would then offer a passphrase
  // form that a device-paired phone can never satisfy (it received entropy,
  // never the 24 words), with no UI to clear it. The passkey itself survives
  // (it is discoverable): passkey login still works, via the browser's account
  // picker, and re-saves the descriptor on success. `initializeKeys` adopts
  // ROOT_KEY on its own, so nothing here needs the credential record.
  return "accepted";
}
