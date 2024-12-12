import { Reference } from "merkle-reference";
import { changes, Doc, Embed, Spell } from "./spell.jsx";
import { Behavior, h, Rule, Selector } from "@commontools/common-system";
import { event } from "../sugar.js";

type Game = {
  board: string;
  width: number;
  height: number;
}

function makeGrid(rows: number, cols: number) {
  return Array.from({ length: rows }, () => Array.from({ length: cols }, () => Math.random() > 0.5 ? '🟨' : '⬜'));
}

function embed(value: any) {
  return JSON.stringify(value);
}

function decode(value: string) {
  return JSON.parse(value);
}

export class GameOfLifeSpell extends Spell<Game> {
  override init() {
    return {
      board: embed(makeGrid(10, 10)),
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
          this.set(self, { board: embed(makeGrid(width, height)) })
        );
      }
    );

    this.addRule(
      event('step')
        .with(this.get('board', this.init().board)),
      ({ self, event, board }) => {
        const grid = Embed.decode<string[][]>(board);

        const rows = grid.length;
        const cols = grid[0].length;
        const newGrid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => '⬜'));

        for (let i = 0; i < rows; i++) {
          for (let j = 0; j < cols; j++) {
            let neighbors = 0;

            for (let x = -1; x <= 1; x++) {
              for (let y = -1; y <= 1; y++) {
                if (x === 0 && y === 0) continue;

                const newI = i + x;
                const newJ = j + y;

                if (newI >= 0 && newI < rows && newJ >= 0 && newJ < cols) {
                  if (grid[newI][newJ] === '🟨') neighbors++;
                }
              }
            }

            if (grid[i][j] === '🟨') {
              newGrid[i][j] = (neighbors === 2 || neighbors === 3) ? '🟨' : '⬜';
            } else {
              newGrid[i][j] = neighbors === 3 ? '🟨' : '⬜';
            }
          }
        }

        return changes(
          this.set(self, { board: embed(newGrid) })
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

  override render({ self, board, width, height }) {
    const grid = decode(board);

    return (
      <div>
        <table>
          {grid.map((row, i) => (
            <tr key={i}>
              {row.map((cell, j) => (
                <td key={j} style="width: 16px; height: 16px; line-height: 16px; overflow: hidden; border: 1px solid #eee; font-size: 12px;">{cell}</td>
              ))}
            </tr>
          ))}
        </table>
        <button onclick={'~/on/step'}>Advance</button>

        <common-input type="number" value={width} oncommon-blur={'~/on/width'} />
        <common-input type="number" value={height} oncommon-blur={'~/on/height'} />
        <button onclick={'~/on/reset'}>Reset</button>
      </div >
    );
  }
}
