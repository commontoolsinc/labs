// mod.ts in your Deno CLI project
import { CharmManager } from "@commontools/charm";

// Your Deno CLI logic here
async function main() {
  const charm = new CharmManager("testing", "remote");
  await charm.init();
  const charms = await charm.getCharms();
  console.log(JSON.stringify(charms, null, 2));
}

main();
