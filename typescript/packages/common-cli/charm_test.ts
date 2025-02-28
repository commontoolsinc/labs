import { CharmManager, Charm, createStorage } from "@commontools/charm";
import { Cell } from "../common-runner/src/cell.ts";
import { getDoc } from "../common-runner/src/doc.ts";
import { EntityId } from "../common-runner/src/cell-map.ts";
import { storage } from "../common-charm/src/storage.ts";
import { getSpace, Space } from "../common-runner/src/space.ts";

const replica = "ellyse6";
const TOOLSHED_API_URL = "https://toolshed.saga-castor.ts.net/";

// i'm running common memory locally, so connect to it directly
const BASE_URL = "http://localhost:8000"

// simple log function
const log: <T>(s: T, prefix?: string) => void = (s, prefix?) => 
  console.log((prefix ? prefix : "") + "--------\n" + JSON.stringify(s, null, 2));

function createCell(space: Space): Cell<any>  {
  const emptyDoc = getDoc<number>(10, crypto.randomUUID(), space);
  log(emptyDoc, "empty doc");
  return emptyDoc.asCell();
}

async function main() {
  
  // create a charm manager to start things off
  const charmManager = new CharmManager(replica);
  log(charmManager, "charmManager");

  // let's try to create a cell 
  const space: Space = getSpace(replica);
  const cell: Cell<Charm> = createCell(space);
  log(cell, "charmmanager empty cell");

  // this feels like magic and wrong
  storage.setRemoteStorage(
    new URL(TOOLSHED_API_URL)
  );

  // let's add the cell to the charmManager
  await charmManager.add([cell]);
  log(charmManager, "charmmanager after adding cell");
}

main();
