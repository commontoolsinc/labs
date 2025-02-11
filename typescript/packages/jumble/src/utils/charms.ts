import { type Charm } from "@commontools/charm";
import { EntityId } from "@commontools/runner";

export function charmId(charm: Charm | EntityId) {
  if ("cell" in charm) {
    if (typeof charm.cell.entityId["/"] === "string") {
      return charm.cell.entityId["/"];
    } else {
      return charm.cell.toJSON()["/"];
    }
  } else {
    return charm.toJSON?.()?.["/"];
  }
}
