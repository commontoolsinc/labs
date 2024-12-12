import { Reference } from "merkle-reference";
import { changes, Doc, Embed, Spell } from "./spell.jsx";
import { Behavior, h, Rule, Selector } from "@commontools/common-system";
import { event } from "../sugar.js";

type Game = {
  redBoard: string;
  greenBoard: string;
  blueBoard: string;
  width: number;
  height: number;
}

function makeGrid(rows: number, cols: number) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.random() > 0.7 ? 1 : 0));
}

function embed(value: any) {
  return JSON.stringify(value);
}

function decode(value: string) {
  return JSON.parse(value);
}

function blendColors(red: number, green: number, blue: number): string {
  const r = Math.min(255, red * 255);
  const g = Math.min(255, green * 255);
  const b = Math.min(255, blue * 255);
  return `rgb(${r},${g},${b})`;
}

const processLayer = (grid: number[][]) => {
  const rows = grid.length;
  const cols = grid[0].length;
  const newGrid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));

  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      let neighbors = 0;

      for (let x = -1; x <= 1; x++) {
        for (let y = -1; y <= 1; y++) {
          if (x === 0 && y === 0) continue;

          const newI = i + x;
          const newJ = j + y;

          if (newI >= 0 && newI < rows && newJ >= 0 && newJ < cols) {
            if (grid[newI][newJ] === 1) neighbors++;
          }
        }
      }

      if (grid[i][j] === 1) {
        newGrid[i][j] = (neighbors === 2 || neighbors === 3) ? 1 : 0;
      } else {
        newGrid[i][j] = neighbors === 3 ? 1 : 0;
      }
    }
  }
  return newGrid;
};

export class GameOfLifeSpell extends Spell<Game> {
  override init() {
    return {
      redBoard: embed(makeGrid(10, 10)),
      greenBoard: embed(makeGrid(10, 10)),
      blueBoard: embed(makeGrid(10, 10)),
      width: 10,
      height: 10,
    };
  }

  constructor() {
    super();

    this.addRule(
      event('reset')
        .with(this.get('width', 10))
        .with(this.get('height', 10)),
      ({ self, width, height }) => {
        return changes(
          this.set(self, {
            redBoard: embed(makeGrid(width, height)),
            greenBoard: embed(makeGrid(width, height)),
            blueBoard: embed(makeGrid(width, height))
          })
        );
      }
    );

    this.addRule(
      event('step')
        .with(this.get('redBoard', this.init().redBoard))
        .with(this.get('greenBoard', this.init().greenBoard))
        .with(this.get('blueBoard', this.init().blueBoard)),
      ({ self, redBoard, greenBoard, blueBoard }) => {


        const redGrid = processLayer(decode(redBoard));
        const greenGrid = processLayer(decode(greenBoard));
        const blueGrid = processLayer(decode(blueBoard));

        return changes(
          this.set(self, {
            redBoard: embed(redGrid),
            greenBoard: embed(greenGrid),
            blueBoard: embed(blueGrid)
          })
        );
      })

    this.addEventListener('width', (self, ev) => {
      return changes(
        this.set(self, { width: ev.detail.value })
      );
    })

    this.addEventListener('height', (self, ev) => {
      return changes(
        this.set(self, { height: ev.detail.value })
      );
    })
  }

  override render({ self, redBoard, greenBoard, blueBoard, width, height }) {
    const redGrid = decode(redBoard);
    const greenGrid = decode(greenBoard);
    const blueGrid = decode(blueBoard);

    return (
      <div>
        <table style="border-spacing: 0">
          {Array.from({ length: Math.max(redGrid.length, greenGrid.length, blueGrid.length) }, (_, i) => (
            <tr key={i}>
              {Array.from({
                length: Math.max(
                  redGrid[0]?.length || 0,
                  greenGrid[0]?.length || 0,
                  blueGrid[0]?.length || 0
                )
              }, (_, j) => (
                <td key={j} style={`width: 8px; height: 8px; line-height: 16px; overflow: hidden; background-color: ${blendColors(
                  redGrid[i]?.[j] || 0,
                  greenGrid[i]?.[j] || 0,
                  blueGrid[i]?.[j] || 0
                )};`}></td>
              ))}
            </tr>
          ))}
        </table>
        <button onclick={'~/on/step'}>Advance</button>

        <common-input type="number" value={width} oncommon-blur={'~/on/width'} />
        <common-input type="number" value={height} oncommon-blur={'~/on/height'} />
        <button onclick={'~/on/reset'}>Reset</button>
      </div>
    );
  }
}
