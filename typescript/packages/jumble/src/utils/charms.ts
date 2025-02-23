import { type Charm } from "@commontools/charm";
import { getEntityId } from "@commontools/runner";

export function charmId(charm: Charm): string | undefined {
  const id = getEntityId(charm);
  return id ? id["/"] : undefined;
}
