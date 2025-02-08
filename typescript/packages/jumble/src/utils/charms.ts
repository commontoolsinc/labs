import { type Charm } from "@commontools/charm";

export function charmId(charm: Charm) {
  if (typeof charm.cell.entityId["/"] === "string") {
    return charm.cell.entityId["/"];
  } else {
    return charm.cell.toJSON()["/"];
  }
}
