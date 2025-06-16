/**
 * @file This file is Ellyse's exploration into the interactions between
 * charms, cells, and documents, and how they relate to common memory.
 *
 * I'm starting from the bottom (common memory) up and purposely calling
 * APIs that would normally call into common memory.
 */
import { charmListSchema } from "../charm/src/manager.ts";
import { Cell, type CellLink } from "../runner/src/cell.ts";
import { DocImpl } from "../runner/src/doc.ts";
import { Runtime } from "../runner/src/index.ts";
import { StorageManager } from "@commontools/runner/storage/cache.deno";
import { Identity } from "../identity/src/index.ts";
import { getEntityId } from "../runner/src/doc-map.ts";

const TOOLSHED_API_URL = "https://toolshed.saga-castor.ts.net/";

// simple log function
const log: <T>(s: T, prefix?: string) => void = (s, prefix?) =>
  console.log(
    "-------------\n" + (prefix ? prefix : "") + ":\n" +
      JSON.stringify(s, null, 2),
  );

async function main() {
  const account = await Identity.fromPassphrase("some passphrase");
  const as_space = await account.derive("some name");
  const space_did = as_space.did();

  // Create runtime with proper configuration
  const runtime = new Runtime({
    storageManager: StorageManager.open({
      as: as_space,
      address: new URL("/api/storage/memory", TOOLSHED_API_URL),
    }),
    blobbyServerUrl: TOOLSHED_API_URL,
  });

  // get them charms, we can also call charmManager.getCharms()
  // this way is to show what these objects really are
  const charmsDoc: DocImpl<CellLink[]> = runtime.documentMap.getDoc<CellLink[]>(
    [],
    "charms",
    as_space.did(),
  );

  // start syncing on this document
  // notice that we call syncCell on a DocImpl
  runtime.storage.syncCell(charmsDoc);

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
//   this.charmsDoc = getDoc<CellLink[]>([], "charms", this.space);
//   this.pinned = getDoc<CellLink[]>([], "pinned-charms", this.space);
//   this.charms = this.charmsDoc.asCell([], undefined, charmListSchema);
//   storage.setSigner(signer);
//   this.pinnedCharms = this.pinned.asCell([], undefined, charmListSchema);
// }
