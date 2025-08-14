import * as Automerge from "@automerge/automerge";
import { decodeChangeHeader } from "./change.ts";

/**
 * Build a deterministic "genesis" change for a document by:
 * - Initializing an Automerge doc with the actor id set to the docId
 * - Applying a single change that sets and deletes a temporary key
 *   within the same change block so the net result is an empty object
 * - Returning the change hash (the genesis head)
 */
function toHexUtf8(s: string): string {
  const enc = new TextEncoder();
  return Array.from(enc.encode(s)).map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function initWithActor<T>(actor: string): T {
  return Automerge.init({ actor: toHexUtf8(actor) }) as unknown as T;
}

export function computeGenesisHead(docId: string): string {
  // Initialize with a deterministic actor id based on docId
  const doc = initWithActor<Automerge.Doc<unknown>>(docId);

  const changed = Automerge.change(doc, { time: 0 }, (d: Record<string, unknown>) => {
    // produce at least one operation with zero net effect
    (d as Record<string, unknown>)["__genesis__"] = 1 as unknown as never;
    delete (d as Record<string, unknown>)["__genesis__"];
  });
  const c = Automerge.getLastLocalChange(changed);
  if (!c) throw new Error("failed to produce genesis change");
  const hdr = decodeChangeHeader(c);
  return hdr.changeHash;
}

/**
 * Create a client-side Automerge document that has the deterministic genesis
 * change applied (actor id = docId), then fork it for subsequent edits under
 * an optional `forkActorId`. Returns the forked doc if fork is available.
 */
export function createGenesisDoc<T = unknown>(
  docId: string,
  forkActorId?: string,
): T {
  // Initialize with deterministic actor id
  let base = initWithActor<Automerge.Doc<unknown>>(docId);
  base = Automerge.change(base, { time: 0 }, (d: Record<string, unknown>) => {
    (d as Record<string, unknown>)["__genesis__"] = 1 as unknown as never;
    delete (d as Record<string, unknown>)["__genesis__"];
  });
  // Prefer fork when available to set client actor id
  const am = Automerge as unknown as { fork?: (d: Automerge.Doc<unknown>, actorId?: string) => T };
  if (typeof am.fork === "function") {
    return forkActorId ? am.fork!(base, forkActorId) : am.fork!(base);
  }
  // Fallback: return the base doc (actor id remains docId)
  return base as T;
}
