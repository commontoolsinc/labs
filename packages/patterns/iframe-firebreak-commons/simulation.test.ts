import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import {
  DEFAULT_INPUT,
  type IframeInputData,
  type SimulationAction,
} from "./contract.ts";
import { reduceSimulation } from "./simulation.ts";

const input: IframeInputData = {
  ...DEFAULT_INPUT,
  seed: 712_367,
  columns: 8,
  rows: 6,
  initialFireCount: 2,
  maximumTurns: 8,
};

describe("simulation", () => {
  describe("reduceSimulation()", () => {
    it("returns the same seeded board for the same semantic action log", () => {
      const initial = reduceSimulation(input, []);
      const burning = initial.tiles.find((tile) => tile.fire > 0)!;
      const buildable = initial.tiles.find((tile) =>
        tile.fire === 0 &&
        (tile.terrain === "forest" || tile.terrain === "grass")
      )!;
      const actions: SimulationAction[] = [
        {
          id: "action-water",
          actorId: "crew-alice",
          turn: 1,
          type: "water",
          tileId: burning.id,
        },
        {
          id: "action-break",
          actorId: "crew-bob",
          turn: 1,
          type: "firebreak",
          tileId: buildable.id,
        },
        {
          id: "action-advance",
          actorId: "crew-alice",
          turn: 1,
          type: "advance-turn",
        },
      ];

      expect(reduceSimulation(input, actions)).toEqual(
        reduceSimulation(input, [...actions].reverse()),
      );
    });

    it("deduplicates stable action IDs independently of append order", () => {
      const tile = reduceSimulation(input, []).tiles.find((candidate) =>
        candidate.fire > 0
      )!;
      const water: SimulationAction = {
        id: "stable-action",
        actorId: "crew-alice",
        turn: 1,
        type: "water",
        tileId: tile.id,
      };

      const single = reduceSimulation(input, [water]);
      const duplicate = reduceSimulation(input, [water, { ...water }]);

      expect(duplicate).toEqual(single);
      expect(duplicate.acceptedActionIds).toEqual(["stable-action"]);
    });

    it("applies one crew deployment per actor and accepts concurrent crews", () => {
      const initial = reduceSimulation(input, []);
      const fires = initial.tiles.filter((tile) => tile.fire > 0);
      const actions: SimulationAction[] = [
        {
          id: "alice-first",
          actorId: "crew-alice",
          turn: 1,
          type: "water",
          tileId: fires[0].id,
        },
        {
          id: "alice-second",
          actorId: "crew-alice",
          turn: 1,
          type: "water",
          tileId: fires[1].id,
        },
        {
          id: "bob-water",
          actorId: "crew-bob",
          turn: 1,
          type: "water",
          tileId: fires[1].id,
        },
      ];

      const result = reduceSimulation(input, actions);

      expect(result.acceptedActionIds).toEqual([
        "alice-first",
        "bob-water",
      ]);
      expect(result.rejectedActionIds).toEqual(["alice-second"]);
      expect(result.activeFireCount).toBe(0);
      expect(result.status).toBe("contained");
    });

    it("advances a turn once when several crews append advance intents", () => {
      const actions: SimulationAction[] = [
        {
          id: "advance-b",
          actorId: "crew-bob",
          turn: 1,
          type: "advance-turn",
        },
        {
          id: "advance-a",
          actorId: "crew-alice",
          turn: 1,
          type: "advance-turn",
        },
      ];

      const result = reduceSimulation(input, actions);

      expect(result.turn).toBe(2);
      expect(result.acceptedActionIds).toEqual(["advance-a"]);
      expect(result.rejectedActionIds).toEqual(["advance-b"]);
    });

    it("keeps future-turn actions inert until every earlier turn advances", () => {
      const initial = reduceSimulation(input, []);
      const burning = initial.tiles.find((tile) => tile.fire > 0)!;
      const futureWater: SimulationAction = {
        id: "future-water",
        actorId: "crew-alice",
        turn: 2,
        type: "water",
        tileId: burning.id,
      };

      const waiting = reduceSimulation(input, [futureWater]);
      const active = reduceSimulation(input, [
        futureWater,
        {
          id: "advance-turn-one",
          actorId: "crew-bob",
          turn: 1,
          type: "advance-turn",
        },
      ]);

      expect(waiting.acceptedActionIds).not.toContain("future-water");
      expect(active.acceptedActionIds).toContain("future-water");
    });

    it("changes the generated landscape when the input seed changes", () => {
      const first = reduceSimulation(input, []).tiles.map((tile) =>
        tile.terrain
      );
      const second = reduceSimulation({ ...input, seed: input.seed + 1 }, [])
        .tiles.map((tile) => tile.terrain);

      expect(second).not.toEqual(first);
    });
  });
});
