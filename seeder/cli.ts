import { parseArgs } from "@std/cli/parse-args";
import {
  castNewRecipe,
  CharmManager,
  compileAndRunRecipe,
} from "@commontools/charm";
import { getEntityId, setBobbyServerUrl, storage } from "@commontools/runner";
import { createSession, Identity } from "@commontools/identity";
import { LLMClient, setLLMUrl } from "@commontools/llm";
import { createDataCharm, processWorkflow } from "@commontools/charm";
import { type CharmResult, CommandType, type Step } from "./interfaces.ts";
import { scenarios } from "./scenarios.ts";
import { toolshedUrl } from "./env.ts";
import { llmVerifyCharm } from "./judge.ts";
import { ensureReportDir, generateReport } from "./report.ts";
import {
  addErrorListeners,
  browser,
  checkForErrors,
  goto,
  login,
  screenshot,
} from "./jumble.ts";

const {
  name,
  tag,
  "no-cache": noCache,
  model = "anthropic:claude-3-7-sonnet-20250219",
} = parseArgs(
  Deno.args,
  {
    string: ["name", "tag", "model"],
    boolean: ["no-cache"],
  },
);

const cache = !noCache;

if (!name) {
  console.error("Error: Missing `--name`.");
  Deno.exit(1);
}

storage.setRemoteStorage(new URL(toolshedUrl));
setBobbyServerUrl(toolshedUrl);
setLLMUrl(toolshedUrl);
const llmClient = new LLMClient();

const charmManager = new CharmManager(
  await createSession({
    identity: await Identity.fromPassphrase("common user"),
    name,
  }),
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function processPrompts(tag: string | undefined) {
  let promptCount = 0;
  console.log(`Processing prompts...`);

  for (const scenario of scenarios) {
    if (tag && (scenario.tags === undefined || !scenario.tags.includes(tag))) {
      continue;
    }
    await goto(toolshedUrl);
    await sleep(1000);
    let lastCharmId: string | undefined = undefined;
    for (const step of scenario.steps) {
      promptCount++;
      const newCharmId = await processCommand(step, lastCharmId, cache);
      if (newCharmId) {
        lastCharmId = newCharmId;
      }
    }
  }
  console.log(`Successfully processed ${promptCount} prompts.`);
}

async function processCommand(
  step: Step,
  lastCharmId: string | undefined,
  cache = true,
): Promise<string | undefined> {
  const { type, prompt } = step;

  switch (type) {
    case CommandType.New: {
      console.log(`Adding: "${prompt}"`);
      const form = await processWorkflow(prompt, charmManager, {
        cache,
        model,
        prefill: {
          classification: {
            workflowType: "imagine",
            confidence: 1.0,
            reasoning: "hard coded",
          },
        },
      });
      const charm = await castNewRecipe(charmManager, form);
      const id = getEntityId(charm);
      if (id) {
        console.log(`Charm added: ${id["/"]}`);
        await verifyCharm(id["/"], prompt);
        return id["/"];
      }
      break;
    }
    case CommandType.Extend: {
      console.log(`Extending: "${prompt}"`);
      if (!lastCharmId) {
        throw new Error("Last charm ID is undefined.");
      }
      const charm = await charmManager.get(lastCharmId);
      const form = await processWorkflow(prompt, charmManager, {
        existingCharm: charm,
        cache,
        model,
        prefill: {
          classification: {
            workflowType: "imagine",
            confidence: 1.0,
            reasoning: "hard coded",
          },
        },
      });

      await castNewRecipe(charmManager, form);
      const id = getEntityId(charm);
      if (id) {
        console.log(`Charm added: ${id["/"]}`);
        await verifyCharm(id["/"], prompt);
        return id["/"];
      } else {
        console.error(`Charm not added: ${prompt}`);
      }
      break;
    }
    case CommandType.ImportJSON: {
      console.log(`Importing JSON for: "${prompt}"`);
      if (!step.data) {
        throw new Error("Missing data for JSON import.");
      }

      const charm = await createDataCharm(
        charmManager,
        step.data,
        step.dataSchema,
        prompt,
      );

      const id = getEntityId(charm);
      console.log(`Charm added from JSON import`, { id });
      if (id) {
        console.log(`Charm added from JSON import: ${id["/"]}`);
        await verifyCharm(id["/"], "shows a jsonschema for " + prompt);
        return id["/"];
      }
      break;
    }
    case CommandType.Other: {
      throw new Error("Unsupported command type.");
    }
  }
}

const charmResults: CharmResult[] = [];

async function verifyCharm(id: string, prompt: string): Promise<string> {
  // FIXME(ja): can we navigate without causing a page reload?
  await goto(`/${name!}/${id}`);
  addErrorListeners();
  await sleep(5000);
  await ensureReportDir(name!);
  const screenshotPath = `results/${name}/${id}.png`;
  await screenshot(id, screenshotPath);
  const errors = await checkForErrors();
  if (errors.length > 0) {
    charmResults.push({
      id,
      prompt,
      screenshotPath,
      status: "FAIL",
      summary: `Errors: ${errors.join("\n")}`,
    });
    return `Error: ${errors.join("\n")}`;
  }

  const verdict = await llmVerifyCharm(prompt, screenshotPath);
  console.log(`Charm verified: ${id} - ${verdict}`);

  // Parse the verdict and add to results
  const parsedVerdict = JSON.parse(verdict);
  charmResults.push({
    id,
    prompt,
    screenshotPath,
    status: parsedVerdict.result,
    summary: parsedVerdict.summary,
  });

  return verdict;
}

try {
  await login(name);
  await processPrompts(tag);
  await ensureReportDir(name);
  await generateReport(name, charmResults, toolshedUrl, scenarios);
} catch (e) {
  console.error(e);
} finally {
  await sleep(100);
  await browser.close();
  Deno.exit(0);
}
