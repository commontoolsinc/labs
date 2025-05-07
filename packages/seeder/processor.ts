import type {
  CharmResult,
  ExecutedScenario,
  Scenario,
  Step,
} from "./interfaces.ts";
import { Verifier } from "./verifier.ts";
import { CharmManager } from "@commontools/charm";
import { CommandType } from "./interfaces.ts";
import {
  castNewRecipe,
  createDataCharm,
  processWorkflow,
} from "@commontools/charm";
import { getEntityId } from "@commontools/runner";

export class Processor {
  private cache: boolean;
  private charmManager: CharmManager;
  private name: string;
  private model: string;
  private verifier?: Verifier;

  constructor(
    { name, model, cache, charmManager, verifier }: {
      name: string;
      model: string;
      cache: boolean;
      charmManager: CharmManager;
      verifier?: Verifier;
    },
  ) {
    this.cache = cache;
    this.charmManager = charmManager;
    this.model = model;
    this.name = name;
    this.verifier = verifier;
  }

  async process(
    scenarios: Scenario[],
    tag: string | undefined,
  ): Promise<ExecutedScenario[]> {
    console.log(`Processing scenarios...`);

    const executed = [];
    for (const scenario of scenarios) {
      if (
        tag && (scenario.tags === undefined || !scenario.tags.includes(tag))
      ) {
        continue;
      }
      executed.push(await this.processScenario(scenario));
    }
    console.log(`Processed ${executed.length} scenarios.`);
    return executed;
  }

  private async processScenario(scenario: Scenario): Promise<ExecutedScenario> {
    const results: CharmResult[] = [];

    let prevCharmId: string | undefined;
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
        result = await this.processCommand({
          step,
          prevCharmId,
        });
        results.push(result);
      } catch (error: any) {
        console.error(`Error processing step`, { step, scenario, error });
        failed = true;
        results.push({
          id: "error",
          prompt: step.prompt,
          status: "FAIL",
          summary: error && error.message ? error.message : error,
        });
        continue;
      }
      if (result.id) {
        prevCharmId = result.id;
      }
    }
    return { scenario, results };
  }

  private async processCommand({
    step,
    prevCharmId,
  }: {
    step: Step;
    prevCharmId: string | undefined;
  }): Promise<CharmResult> {
    const { type, prompt } = step;

    switch (type) {
      case CommandType.New: {
        console.log(`Adding: "${prompt}"`);
        const form = await processWorkflow(prompt, this.charmManager, {
          cache: this.cache,
          model: this.model,
          prefill: {
            classification: {
              workflowType: "imagine",
              confidence: 1.0,
              reasoning: "hard coded",
            },
          },
        });
        const { cell: charm } = await castNewRecipe(this.charmManager, form);
        const id = getEntityId(charm);
        if (id) {
          console.log(`Charm added: ${id["/"]}`);
          return this.verify({ id: id["/"], prompt, name: this.name });
        }
        break;
      }
      case CommandType.Extend: {
        console.log(`Extending: "${prompt}"`);
        if (!prevCharmId) {
          throw new Error("Previous charm ID is undefined.");
        }
        const charm = await this.charmManager.get(prevCharmId);
        const form = await processWorkflow(prompt, this.charmManager, {
          existingCharm: charm,
          cache: this.cache,
          model: this.model,
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
          return this.verify({ id: id["/"], prompt, name: this.name });
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
          this.charmManager,
          step.data,
          step.dataSchema,
          prompt,
        );

        const id = getEntityId(charm);
        console.log(`Charm added from JSON import`, { id });
        if (id) {
          console.log(`Charm added from JSON import: ${id["/"]}`);
          return this.verify({
            id: id["/"],
            prompt: "shows a jsonschema for " + prompt,
            name: this.name,
          });
        }
        break;
      }
    }

    return {
      id: null,
      prompt,
      status: "FAIL",
      summary: `Unsupported command type: ${type}`,
    };
  }

  async verify(
    { id, prompt, name }: { id: string; prompt: string; name: string },
  ): Promise<CharmResult> {
    return await (this.verifier ? this.verifier.verify({ id, prompt, name }) : {
      id,
      prompt,
      status: "NOTVERIFIED",
      summary: "Scenario was not verified.",
    });
  }
}
