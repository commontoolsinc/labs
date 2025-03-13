/**
 * @file This file is Ellyse's exploration into the interactions between
 * charms, cells, and documents, and how they relate to common memory.
 *
 * I'm starting from the bottom (common memory) up and purposely calling
 * APIs that would normally call into common memory.
 */
import { Charm, CharmManager, charmListSchema } from "../charm/src/charm.ts";
import { type CellLink, Cell } from "../runner/src/cell.ts";
import * as Session from "./session.ts";
import { DocImpl, getDoc } from "../runner/src/doc.ts";
import { EntityId } from "../runner/src/doc-map.ts";
import { storage } from "../runner/src/storage.ts";
import { Identity } from "../identity/src/index.ts";
import { getEntityId } from "../runner/src/doc-map.ts";

const TOOLSHED_API_URL = "https://toolshed.saga-castor.ts.net/";
const SPACE = "common-knowledge"; 

// simple log function
const log: <T>(s: T, prefix?: string) => void = (s, prefix?) =>
  console.log(
    "-------------\n" + (prefix ? prefix : "") + ":\n" +
      JSON.stringify(s, null, 2),
  );

async function main() {
  const session = await Session.create({
    passphrase: "some passphrase",
    name: "some name",
  });

  const authority = await Identity.fromPassphrase("charm manager");

  // this feels like magic and wrong,
  // but we crash when we call syncCell otherwise 
  storage.setRemoteStorage(
    new URL(TOOLSHED_API_URL),
  );
  storage.setSigner(session.as);

  // get them charms, we can also call charmManager.getCharms()
  // this way is to show what these objects really are
  const charmsDoc: DocImpl<DocLink[]> = getDoc<DocLink[]>([], "charms", SPACE);

  // start syncing on this document
  // notice that we call syncCell on a DocImpl
  storage.syncCell(charmsDoc);

  // the list of charms
  const charms: Cell<any> = charmsDoc.asCell([], undefined, charmListSchema); 
  charms.sink((charmList) => {
    if (charmList.length > 0) {
      console.log(`\nFound ${charmList.length} charms`);
  
      // Print details for each charm
      charmList.forEach((charm: any, index: number) => {
        const id = getEntityId(charm)?.["/"] || "unknown-id";
        const name = charm.get()?.NAME || "Unnamed";
    
        console.log(`${index}. ${name}`);
        console.log(`   ID: ${id}`);
        console.log("");
      });
    }
  });

  log(charms, "charms via getDoc");
}

main();

//function bar() {
    // get all the charms
  // const charms = charmManager.getCharms();

  // Create a promise that resolves when we receive the charms
  // await new Promise<void>((resolve) => {
  //   charms.sink((charmList) => {
  //     console.log(`\nFound ${charmList.length} charms:`);
      
  //     // Print details for each charm
  //     charmList.forEach((charm, index) => {
  //       const id = getEntityId(charm)?.["/"] || "unknown-id";
  //       const name = charm.get()?.NAME || "Unnamed";
        
  //       console.log(`${index + 1}. ${name}`);
  //       console.log(`   ID: ${id}`);
  //       console.log("");
  //     });

  //     if (charmList.length > 0) {
  //       resolve();
  //     }
  //   });
  // });
//}

// function foo() {
//   this.space = getSpace(this.spaceId);
//   this.charmsDoc = getDoc<DocLink[]>([], "charms", this.space);
//   this.pinned = getDoc<DocLink[]>([], "pinned-charms", this.space);
//   this.charms = this.charmsDoc.asCell([], undefined, charmListSchema);
//   storage.setSigner(signer);
//   this.pinnedCharms = this.pinned.asCell([], undefined, charmListSchema);
// }
