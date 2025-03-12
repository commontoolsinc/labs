/**
 * @file This file is Ellyse's exploration into the interactions between
 * charms, cells, and documents, and how they relate to common memory.
 *
 * I'm starting from the bottom (common memory) up and purposely calling
 * APIs that would normally call into common memory.
 */
import { Charm, CharmManager } from "../charm/src/charm.ts";
import { Cell } from "../runner/src/cell.ts";
import { DocImpl, getDoc } from "../runner/src/doc.ts";
import { storage } from "../runner/src/storage.ts";
import * as Session from "./session.ts";

const TOOLSHED_API_URL = "https://toolshed.saga-castor.ts.net/";

// simple log function
const log: <T>(s: T, prefix?: string) => void = (s, prefix?) =>
  console.log(
    "-------------\n" + (prefix ? prefix : "") + ":\n" +
      JSON.stringify(s, null, 2),
  );

function createCell(space: string): Cell<Charm> {
  const myCharm: Charm = {
    NAME: "mycharm",
    UI: "someui",
    somekey: "some value",
  };

  // make this a DocImpl<Charm> because we need to return a Cell<Charm> since
  // that's what CharmManger.add() needs later on
  const myDoc: DocImpl<Charm> = getDoc<Charm>(
    myCharm,
    crypto.randomUUID(),
    space,
  );
  return myDoc.asCell();
}

async function main() {
  // create a charm manager to start things off
  const session = await Session.create({
    passphrase: "super secret",
    name: "charm manager",
  });
  const charmManager = new CharmManager(session);
  log(charmManager, "charmManager");

  // let's try to create a cell
  const space = charmManager.getSpace();
  const cell: Cell<Charm> = createCell(space);
  log(cell.get(), "cell value from Cell.get()");

  // this feels like magic and wrong,
  // but we crash in the next CharmManager.add() if this isn't set
  storage.setRemoteStorage(
    new URL(TOOLSHED_API_URL),
  );

  // let's add the cell to the charmManager
  await charmManager.add([cell]);
  log(charmManager, "charmmanager after adding cell");
}

main();
