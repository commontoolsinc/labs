// Load .env file
import { parseArgs } from "@std/cli/parse-args";
import { castNewRecipe, CharmManager, compileRecipe } from "@commontools/charm";
import {
  getEntityId,
  isStream,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { generateJSON } from "@commontools/llm";
import * as Session from "./session.ts";

const { name, quit, prompt, prompts } = parseArgs(
  Deno.args,
  {
    string: [
      "name",
      "prompt",
      "prompts",
      "quit",
    ],
    boolean: ["quit"],
    default: { quit: false, name: "dreamer" },
  },
);

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);

async function main() {
  const session = await Session.create({
    name: name!,
    passphrase: Session.ANYONE,
  });

  console.log("params:", {
    session,
    quit,
    toolshedUrl,
    prompt,
    prompts,
  });
  const manager = new CharmManager(session);
  const charms = manager.getCharms();
  charms.sink((charms) => {
    console.log(
      "all charms:",
      charms.map((c) => getEntityId(c)?.["/"]),
    );
  });

  const generate = async (prompt: string) => {
    const dummyData = await generateJSON(prompt);
    const newCharm = await castNewRecipe(manager, dummyData, prompt);
    if (!newCharm) {
      throw new Error("Failed to cast charm");
    }
    const id = getEntityId(newCharm)?.["/"];
    console.log("Created new charm with ID:", id);
    await storage.synced();
    return newCharm;
  };

  if (prompts) {
    const data = JSON.parse(Deno.readTextFileSync(prompts));
    for (const prompt of data) {
      await generate(prompt);
    }
  } else if (prompt) {
    await generate(prompt);
  }

  await storage.synced();
  Deno.exit(0);
}

main();
