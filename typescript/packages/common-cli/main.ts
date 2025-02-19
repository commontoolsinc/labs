// Load .env file
import { CharmManager, createStorage } from "@commontools/charm";
import { fetchInboxEmails } from "./gmail.ts";

const replica = "anotherjesse-test5";
const charmId = "baedreihwuw4dbkvcel76siqztlxvloddfahgu535yupgxvkh5ml3wtqgqu";
async function main() {
  const storage = createStorage({
    type: "remote",
    replica,
    url: new URL("https://toolshed.saga-castor.ts.net/"),
  });
  const manager = new CharmManager(storage);
  const charms = await manager.getCharms();

  await new Promise((resolve) => {
    charms.sink((charms) => {
      if (charms.length > 0) {
        charms.forEach((charm) => {
          manager.get(charm.cell.entityId["/"]);
        });
        resolve(undefined);
      }
    });
  });

  const charm = await charms.get(charmId);
  console.log({ charm });

  const emails = await fetchInboxEmails();
  console.log({ emails });
}

main();
