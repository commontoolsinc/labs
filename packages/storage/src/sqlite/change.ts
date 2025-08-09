import * as Automerge from "@automerge/automerge";
import type { DecodedChangeHeader } from "../../interface.ts";

export function decodeChangeHeader(bytes: Uint8Array): DecodedChangeHeader {
  const change = Automerge.decodeChange(bytes);
  if (!change.hash) {
    throw new Error("automerge change has no hash");
  }
  return {
    changeHash: change.hash,
    deps: change.deps ?? [],
    actorId: change.actor,
    seq: change.seq,
  };
}


