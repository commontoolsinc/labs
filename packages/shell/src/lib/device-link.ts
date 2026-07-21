// Device-link login: `#k=<base64url 32-byte BIP39 entropy>`.
//
// WHY: an identity minted on a desktop had no way to reach a phone or a second
// browser. The interim answer is to hand the identity across as its BIP39
// entropy — the 32 bytes a 24-word phrase encodes — in a URL fragment, scanned
// from a QR with the phone's native camera. The fragment is never sent to a
// server, and 32 bytes fit in a QR where 24 words do not.
//
// This is an INTERIM mechanism, scoped to be deleted when key delegation
// lands. It is confirm-gated on purpose: a credential in a URL is an
// antipattern, and the confirm screen is the only thing standing between a
// user and a link that would sign them in as somebody else.
//
// SECURITY: the fragment is scrubbed from the URL SYNCHRONOUSLY, before any
// await, so the secret never survives into session history, a bookmark, or
// iCloud tab/bookmark sync. `pathname + search` is preserved because the
// pairing QR targets a deep link — after the confirm, the normal boot must
// continue to that path so the flow ends inside a logged-in app the user can
// bookmark, and the scrubbed URL is exactly what gets bookmarked.

/** Fragment param name. Short because QR payload bytes are scarce. */
const DEVICE_LINK_PREFIX = "#k=";

/** 32 bytes of BIP39 entropy is exactly 43 unpadded base64url characters. */
const ENCODED_LENGTH = 43;
const ENTROPY_BYTES = 32;

const ENCODED_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${ENCODED_LENGTH}}$`);

/**
 * Decode unpadded base64url to bytes, or null if it isn't valid.
 */
function decodeBase64Url(encoded: string): Uint8Array | null {
  if (!ENCODED_PATTERN.test(encoded)) return null;
  const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  if (binary.length !== ENTROPY_BYTES) return null;
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Parse a location hash into device-link entropy.
 *
 * Pure and total: any hash that isn't exactly a well-formed device link
 * yields null. Exported for tests — `consumeDeviceLinkFragment` is the one
 * callers use.
 */
export function parseDeviceLinkFragment(hash: string): Uint8Array | null {
  if (!hash.startsWith(DEVICE_LINK_PREFIX)) return null;
  return decodeBase64Url(hash.slice(DEVICE_LINK_PREFIX.length));
}

/** True when a hash is SHAPED like a device link, valid or not. */
export function looksLikeDeviceLink(hash: string): boolean {
  return hash.startsWith(DEVICE_LINK_PREFIX);
}

/**
 * Read the device-link entropy out of the current URL and scrub it.
 *
 * Call at module init, BEFORE any await. Anything shaped like a device link is
 * scrubbed even when it fails to parse: a malformed payload is still somebody's
 * secret, and leaving it in the address bar to be bookmarked or synced would be
 * the same leak with none of the benefit.
 */
export function consumeDeviceLinkFragment(): Uint8Array | null {
  const location = globalThis.location;
  if (!location || !looksLikeDeviceLink(location.hash)) return null;

  const entropy = parseDeviceLinkFragment(location.hash);

  // Scrub FIRST and synchronously — before the caller can await anything.
  try {
    globalThis.history?.replaceState(
      null,
      "",
      location.pathname + location.search,
    );
  } catch {
    // A sandboxed/unsupported history is not a reason to abandon the login;
    // the secret is merely more exposed than we'd like, which the confirm
    // screen's bookmark guidance already covers.
  }

  return entropy;
}
