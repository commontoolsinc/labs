import { parseArgs } from "@std/cli/parse-args";
import {
  castNewRecipe,
  CharmManager,
  compileAndRunRecipe,
} from "@commontools/charm";
import {
  getRecipe,
  getRecipeSrc,
  setBobbyServerUrl,
  storage,
} from "@commontools/runner";
import { createSession, Identity } from "@commontools/identity";
import { client as llm } from "@commontools/llm";
import { prompts } from "./prompts.ts";
import { Command, CommandType } from "./commands.ts";

const toolshedUrl = Deno.env.get("TOOLSHED_API_URL") ??
  "https://toolshed.saga-castor.ts.net/";

const { space } = parseArgs(Deno.args, {
  string: ["space"],
});

if (!space) {
  console.error("Error: Missing `--space`.");
  Deno.exit(1);
}

async function processPrompts(
  { spaceName, apiUrl, userPassphrase }: {
    spaceName: string;
    apiUrl: string;
    userPassphrase: string;
  },
) {
  llm.setServerUrl(apiUrl);
  storage.setRemoteStorage(new URL(apiUrl));
  setBobbyServerUrl(apiUrl);

  const charmManager = new CharmManager(
    await createSession({
      identity: await Identity.fromPassphrase(userPassphrase),
      name: spaceName,
    }),
  );

  let promptCount = 0;
  console.log(`Processing prompts...`);

  for (const command of prompts) {
    promptCount++;
    await processCommand(charmManager, command);
  }
  console.log(`Successfully processed ${promptCount} prompts.`);
}

async function processCommand(charmManager: CharmManager, command: Command) {
  const { type, prompt } = command;
  switch (type) {
    case CommandType.New: {
      console.log(`Adding: "${prompt}"`);
      const charm = await castNewRecipe(charmManager, prompt);
      await charmManager.synced();
      break;
    }
    case CommandType.Other: {
      throw new Error("Unsupported command type.");
    }
  }
}

await processPrompts({
  spaceName: space,
  apiUrl: toolshedUrl,
  userPassphrase: "common user",
});
Deno.exit(0);
