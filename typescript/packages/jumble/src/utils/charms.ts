import { type Charm } from "@commontools/charm";
import { getEntityId, type EntityId } from "@commontools/runner";

export function charmId(charm: Charm): string | undefined {
  const id = getEntityId(charm);
  // FIXME(ja):   Type 'Uint8Array<ArrayBufferLike>' is not assignable to type 'string'.ts(2322)
  return id ? id["/"] : undefined;
}
