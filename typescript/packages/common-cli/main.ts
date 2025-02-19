import { load } from "https://deno.land/std@0.216.0/dotenv/mod.ts";
import { CharmManager, createStorage } from "@commontools/charm";
import { fetchCalendarEvents } from "./google_calendar";
import { NotesWatcher } from "./notes";
import { ReadwiseClient } from "./readwise";
import { ArenaClient } from "./arena";


// Load .env file
const env = await load({
  envPath: "./.env",
  // you can also specify multiple possible paths:
  // paths: [".env.local", ".env"]
  export: true, // this will export to process.env
});

async function main() {
  const storage = createStorage({
    type: "remote",
    replica: "anotherjesse-test5",
    url: new URL("https://toolshed.saga-castor.ts.net/"),
  });
  const manager = new CharmManager(storage);
  const charms = await manager.getCharms();

  // const events = await fetchCalendarEvents();
  // console.log(events);
  //
  // const watcher = new NotesWatcher("/Users/ben/code/common-tools/labs/typescript/packages/common-cli/notes", (change) => {
  //   console.log('File changed:', change.path);
  //   console.log('Change type:', change.type);
  //   if (change.content) {
  //     console.log('Content:', change.content);
  //   }
  // });

  // // Get initial list of files
  // const files = await watcher.listFiles();
  // console.log('Initial files:', files);

  // // Start watching for changes
  // await watcher.start();

  // const client = new ReadwiseClient(Deno.env.get("READWISE_TOKEN") || "");

  // // Fetch some random highlights
  // const highlights = await client.getRandomHighlights(5);
  // console.log(highlights);


  const client = new ArenaClient();

  // Get channel info
  const channel = await client.getChannel("arena-influences");

  // Get paginated contents
  const contents = await client.getChannelContents("arena-influences", {
    page: 1,
    per: 25
  });


  console.log(contents);

  charms.sink((charms) => {
  //   console.log(JSON.stringify({charms}, null, 2));
    charms.forEach((charm) => {
      manager.get(charm.cell.entityId["/"]);
    });
  });

  // const charm = await charms.get("baedreihwuw4dbkvcel76siqztlxvloddfahgu535yupgxvkh5ml3wtqgqu");
  // console.log({charm});
}

main();
