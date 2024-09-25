import { html } from "@commontools/common-html";
import { recipe, handler, UI, NAME, cell, ifElse, lift } from "@commontools/common-builder";
import { iframeExample } from "./iframeExample.js";
import { launch } from "../data.js";

type Position = { x: number; y: number; }

interface DungeonGame {
  width: number;
  height: number;
  walls: Position[],
  name: string;
  player: Position;
  hp: number;
  xp: number;
  inventory: string[];
}

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

const cloneRecipe = handler<void, DungeonGame>((_, { walls, player, name, width, height, hp, xp, inventory }) => {
  launch(iframeExample, { data: { walls, player, name, width, height, hp, xp, inventory }, title: 'Dungeon', prompt: 'top down grid view of map showing player position' });
});

const createGrid = (w: number, h: number, init: (x: number, y: number) => number): number[][] => {
  return Array(h).fill(null).map((_, y) => Array(w).fill(null).map((_, x) => init(x, y)));
};

const generateNoise = (x: number, y: number, scale: number = 0.1): number => {
  const noise = Math.sin(x * scale) * Math.cos(y * scale) + Math.sin(x * scale / 2 + y * scale / 2);
  return noise > 0 ? 1 : 0;
};

const createNoiseGrid = (w: number, h: number): Position[] => {
  const walls: Position[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (generateNoise(x, y, 1) === 1) {
        walls.push({ x, y });
      }
    }
  }
  return walls;
};

export const dungeon = recipe<DungeonGame>("Import Calendar", ({ walls, player, name, width, height, hp, xp, inventory }) => {
  walls.setDefault(createNoiseGrid(10, 10))
  player.setDefault({ x: 5, y: 5})
  width.setDefault(10)
  height.setDefault(10)
  name.setDefault("Dungeon Adventure")
  hp.setDefault(100)
  xp.setDefault(0)
  inventory.setDefault(['sword', 'shield', 'crumpled felt hat'])

  return {
    [NAME]: "Dungeon Adventure",
    [UI]: html`
      <div>
          <common-input
            value=${name}
            placeholder="name"
            oncommon-input=${updateValue({ value: name })}
          ></common-input>
          <h1>Welcome, ${name}!</h1>
        <common-button onclick=${cloneRecipe({ walls, player, name, width, height, hp, xp, inventory })}
          >Begin Adventure</common-button
        >
      </div>
    `,
  };
});
