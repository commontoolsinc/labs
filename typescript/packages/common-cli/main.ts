import { CharmManager, createStorage } from "@commontools/charm";

async function main() {
  const storage = createStorage({
    type: "remote",
    replica: "anotherjesse-test5",
    url: new URL("https://toolshed.saga-castor.ts.net/"),
  });
  const manager = new CharmManager(storage);
  const charms = await manager.getCharms();

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
