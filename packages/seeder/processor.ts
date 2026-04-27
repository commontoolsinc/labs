import type {
  ExecutedScenario,
  PieceResult,
  Scenario,
  Step,
} from "./interfaces.ts";
import { Verifier } from "./verifier.ts";
import { PieceManager } from "@commonfabric/piece";
import { CommandType } from "./interfaces.ts";
import { createDataPiece } from "./data-piece.ts";
import { isRecord } from "@commonfabric/utils/types";

export class Processor {
  private cache: boolean;
  private pieceManager: PieceManager;
  private name: string;
  private model: string;
  private verifier?: Verifier;

  constructor(
    { name, model, cache, pieceManager, verifier }: {
      name: string;
      model: string;
      cache: boolean;
      pieceManager: PieceManager;
      verifier?: Verifier;
    },
  ) {
    this.cache = cache;
    this.pieceManager = pieceManager;
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
    const results: PieceResult[] = [];

    let prevPieceId: string | undefined;
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
      let result: PieceResult;
      try {
        result = await this.processCommand({
          step,
          prevPieceId,
        });
        results.push(result);
      } catch (error: unknown) {
        console.error(`Error processing step`, { step, scenario, error });
        failed = true;
        results.push({
          id: "error",
          prompt: step.prompt,
          status: "FAIL",
          summary: String(
            isRecord(error) && error.message ? error.message : error,
          ),
        });
        continue;
      }
      if (result.id) {
        prevPieceId = result.id;
      }
    }
    return { scenario, results };
  }

  private async processCommand({
    step,
    prevPieceId,
  }: {
    step: Step;
    prevPieceId: string | undefined;
  }): Promise<PieceResult> {
    const { type, prompt } = step;

    switch (type) {
      case CommandType.New: {
        throw new Error(
          `Seeder '${CommandType.New}' workflow generation has been removed: ${prompt}`,
        );
      }
      case CommandType.Extend: {
        throw new Error(
          `Seeder '${CommandType.Extend}' workflow generation has been removed after ${prevPieceId}: ${prompt}`,
        );
      }
      case CommandType.ImportJSON: {
        console.log(`Importing JSON for: "${prompt}"`);
        if (!step.data) {
          throw new Error("Missing data for JSON import.");
        }

        const piece = await createDataPiece(
          this.pieceManager,
          step.data,
          step.dataSchema,
          prompt,
        );

        const id = piece.entityId;
        console.log(`Piece added from JSON import`, { id });
        if (id) {
          console.log(`Piece added from JSON import: ${id["/"]}`);
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
  ): Promise<PieceResult> {
    return await (this.verifier ? this.verifier.verify({ id, prompt, name }) : {
      id,
      prompt,
      status: "NOTVERIFIED",
      summary: "Scenario was not verified.",
    });
  }
}
