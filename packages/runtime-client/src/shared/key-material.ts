/**
 * The invariant: **no key material ever crosses an attach port.**
 *
 * A runtime acts as one principal, and the client that initializes it is the
 * one that supplies the signer. A client that attaches supplies none: it
 * states which principal it believes the runtime acts as, as a DID, and the
 * runtime refuses the attach when that is not the principal it acts as. So
 * there is no step at which an attaching document needs to hand a key across,
 * and an attach frame carrying one is a frame built wrong.
 *
 * It is refused here, by name, rather than left to the platform, because the
 * platform's answer varies and one of its answers is worse than a refusal.
 * Measured on the SP5 spike: a non-extractable `CryptoKey` posted over a
 * `MessagePort` between two WKWebViews throws `DataCloneError` -- an embedding
 * defect, since browsers carry it -- so a frame with a key in it fails there
 * as a transport error, in a shell, at run time, saying nothing about why. The
 * refusal below is what turns that into a named protocol failure everywhere,
 * and it is the reason not to "fix" a `DataCloneError` by finding a way to
 * pass the key: the key was never supposed to be in the frame.
 *
 * What counts as key material is what holds a key in this codebase: a
 * `FabricKeyPair`, in either of its arms, and a bare `CryptoKey`. Both are
 * recognized by their class rather than by their contents -- a `FabricKeyPair`
 * keeps its state in `#` fields, so there is nothing to walk into -- which is
 * also what makes the check exact rather than a guess at what a key looks
 * like.
 */

import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";

/**
 * Where `value` holds key material, or `undefined` where it holds none.
 *
 * The path is dotted, with array indices in brackets, so a refusal can name
 * the field a caller has to fix: `trustSnapshot.signer`, `atoms[1].key`. The
 * empty string means `value` is itself key material.
 *
 * A value reached twice is walked once, so a cyclic value -- which a context
 * built on this side of the wire may be, having been through no decode -- is
 * answered rather than descended forever.
 */
export function findKeyMaterial(value: unknown): string | undefined {
  return findIn(value, "", new Set<object>());
}

/**
 * Refuses a frame holding key material, naming where it sits.
 *
 * This is the protocol layer's refusal, and the whole of the invariant this
 * module states. It is loud on purpose: a frame that reached here with a key
 * in it was built wrong, and the alternative -- letting the platform decide --
 * is a `DataCloneError` in one embedding and silent success in another.
 *
 * @throws If `frame` holds a `FabricKeyPair` or a `CryptoKey` anywhere.
 */
export function assertNoKeyMaterial(frame: unknown): void {
  const at = findKeyMaterial(frame);
  if (at === undefined) return;
  throw new Error(
    `Attach refused: an attach carries no key material, and this one holds ` +
      `some at ${at === "" ? "its root" : `\`${at}\``}.`,
  );
}

function findIn(
  value: unknown,
  path: string,
  seen: Set<object>,
): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (isKeyMaterial(value)) return path;
  if (seen.has(value)) return undefined;
  seen.add(value);

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index++) {
      const found = findIn(value[index], `${path}[${index}]`, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  for (const [key, entry] of Object.entries(value)) {
    const found = findIn(entry, path === "" ? key : `${path}.${key}`, seen);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * Is `value` a key, or a pair of them? `CryptoKey` is absent from some
 * realms this runs in, so it is read off the global rather than named
 * directly.
 */
function isKeyMaterial(value: object): boolean {
  if (value instanceof FabricKeyPair) return true;
  const cryptoKey = (globalThis as { CryptoKey?: unknown }).CryptoKey;
  return typeof cryptoKey === "function" &&
    value instanceof (cryptoKey as new () => object);
}
