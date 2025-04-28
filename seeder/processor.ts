import type {
  CharmResult,
  ExecutedScenario,
  Scenario,
  Step,
} from "./interfaces.ts";
import { llmVerifyCharm } from "./judge.ts";
import { CharmManager } from "@commontools/charm";
import { goto, sleep } from "./jumble.ts";
import { toolshedUrl } from "./env.ts";
import { CommandType } from "./interfaces.ts";
import { addErrorListeners, checkForErrors, screenshot } from "./jumble.ts";
import {
  castNewRecipe,
  createDataCharm,
  processWorkflow,
} from "@commontools/charm";
import { getEntityId } from "@commontools/runner";

export async function processScenario(
  { scenario, model, cache, name, charmManager }: {
    scenario: Scenario;
    model: string;
    cache: boolean;
    name: string;
    charmManager: CharmManager;
  },
): Promise<ExecutedScenario> {
  const results: CharmResult[] = [];

  await goto(toolshedUrl);
  await sleep(1000);
  let lastCharmId: string | undefined;
  let failed = false;
  for (const step of scenario.steps) {
    if (failed) {
      results.push({
        id: "skip",
        prompt: step.prompt,
        status: "FAIL",
        summary: "Failed to process step",
      });
      continue;
    }
    let result: CharmResult;
    try {
      result = await processCommand({
        step,
        lastCharmId,
        cache,
        name,
        model,
        charmManager,
      });
      results.push(result);
    } catch (error) {
      console.error(`Error processing step`, { step, scenario, error });
      failed = true;
      continue;
    }
    if (result.id !== "none") {
      lastCharmId = result.id;
    }
  }
  return { scenario, results };
}

export async function processCommand({
  step,
  lastCharmId,
  cache,
  name,
  model,
  charmManager,
}: {
  step: Step;
  lastCharmId: string | undefined;
  cache: boolean;
  name: string;
  model: string;
  charmManager: CharmManager;
}): Promise<CharmResult> {
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
      const { cell: charm } = await castNewRecipe(charmManager, form);
      const id = getEntityId(charm);
      if (id) {
        console.log(`Charm added: ${id["/"]}`);
        return verifyCharm({ id: id["/"], prompt, name });
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

      const extendedCharm = form.generation?.charm;
      const id = getEntityId(extendedCharm);
      if (id) {
        console.log(`Charm added: ${id["/"]}`);
        return verifyCharm({ id: id["/"], prompt, name });
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
        return verifyCharm({
          id: id["/"],
          prompt: "shows a jsonschema for " + prompt,
          name,
        });
      }
      break;
    }
  }

  return {
    id: "none",
    prompt,
    status: "FAIL",
    summary: `Unsupported command type: ${type}`,
  };
}

export async function verifyCharm(
  { id, prompt, name }: { id: string; prompt: string; name: string },
) {
  // FIXME(ja): can we navigate without causing a page reload?
  await goto(`/${name!}/${id}`);
  addErrorListeners();
  // FIXME(ja): perhaps charm can emit a "ready" event and we can wait for it?
  await sleep(10000);
  const screenshotPath = `results/${name}/${id}.png`;
  await screenshot(id, screenshotPath);
  const errors = await checkForErrors();
  if (errors.length > 0) {
    return {
      id,
      prompt,
      screenshotPath,
      status: "FAIL",
      summary: `Errors: ${errors.join("\n")}`,
    };
  }

  const verdict = await llmVerifyCharm(prompt, screenshotPath);
  console.log(`Charm verified: ${id} - ${verdict}`);

  const parsedVerdict = JSON.parse(verdict);
  return {
    id,
    prompt,
    screenshotPath,
    status: parsedVerdict.result,
    summary: parsedVerdict.summary,
  };
}
