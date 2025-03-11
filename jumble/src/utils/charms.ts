import { type Charm } from "@commontools/charm";
import { getEntityId } from "@commontools/runner";

export function charmId(charm: Charm): string {
  const id = getEntityId(charm);
  if (!id) throw new Error("No charm ID found");
  return id["/"];
}
