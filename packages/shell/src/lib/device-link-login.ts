import { Identity, KeyStore } from "@commonfabric/identity";
import { createPassphraseCredential, saveCredential } from "./credentials.ts";
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

/** Result of an attempted device-link login. */
export type DeviceLinkOutcome =
  | "accepted"
  | "cancelled"
  | "invalid";

async function confirmWithUser(
  incomingDid: string,
  currentDid: string | null,
): Promise<boolean> {
  const view = document.createElement("x-device-link-view");
  view.incomingDid = incomingDid;
  view.currentDid = currentDid;
  document.body.appendChild(view);
  try {
    return await new Promise<boolean>((resolve) => {
      view.addEventListener(
        "device-link-result",
        (event) => resolve(Boolean((event as CustomEvent).detail?.accepted)),
        { once: true },
      );
    });
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
  openKeyStore: () => Promise<KeyStore> = () => KeyStore.open(),
): Promise<DeviceLinkOutcome> {
  let identity: Identity;
  try {
    // BIP39 entropy is the ed25519 seed directly — `Identity.fromEntropy` names
    // that contract, and the identity package pins it against `fromMnemonic`.
    identity = await Identity.fromEntropy(entropy);
  } catch {
    return "invalid";
  }

  const keyStore = await openKeyStore();
  const existing = await keyStore.get(ROOT_KEY);
  const currentDid = existing ? existing.did() : null;

  if (!await confirm(identity.did(), currentDid)) return "cancelled";

  // Already this identity: nothing to write, and rewriting would be a
  // needless churn of the stored key.
  if (currentDid !== identity.did()) {
    await keyStore.set(ROOT_KEY, identity);
    saveCredential(createPassphraseCredential());
  }
  return "accepted";
}
