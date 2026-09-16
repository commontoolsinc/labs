/** Exercises ship placement when a random candidate overlaps an existing ship. */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";

import {
  generateRandomShips,
  getShipCoordinates,
} from "../../battleship/shared/game-logic.tsx";

// Every placement draws orientation, row, and column. The second candidate
// repeats the carrier's start; the remaining candidates occupy separate rows.
const placements = [
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  0.1,
  0,
  0,
  0.2,
  0,
  0,
  0.3,
  0,
  0,
  0.4,
  0,
];

describe("game-logic", () => {
  it("rejects an overlapping random placement before placing the next ship", () => {
    let draw = 0;
    using random = stub(Math, "random", () => {
      const value = placements[draw++];
      if (value === undefined) throw new Error("Unexpected placement draw");
      return value;
    });
    const ships = generateRandomShips();
    expect(
      ships.map(({ type, start, orientation }) => ({
        type,
        start,
        orientation,
      })),
    )
      .toEqual([
        {
          type: "carrier",
          start: { row: 0, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "battleship",
          start: { row: 1, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "cruiser",
          start: { row: 2, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "submarine",
          start: { row: 3, col: 0 },
          orientation: "horizontal",
        },
        {
          type: "destroyer",
          start: { row: 4, col: 0 },
          orientation: "horizontal",
        },
      ]);
    const coordinates = ships.flatMap(getShipCoordinates).map(({ row, col }) =>
      `${row},${col}`
    );
    expect(new Set(coordinates).size).toBe(coordinates.length);
    expect(random.calls).toHaveLength(placements.length);
  });
});
