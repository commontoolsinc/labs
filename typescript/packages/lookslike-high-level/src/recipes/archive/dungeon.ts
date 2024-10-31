import { html } from "@commontools/common-html";
import {
  recipe,
  handler,
  UI,
  NAME,
  navigateTo,
} from "@commontools/common-builder";
import { iframe } from "./iframe.js";

type Position = { x: number; y: number };
type Actor = {
  name: string;
  position: Position;
  hp: number;
  xp: number;
  inventory: string[];
  dialogue: string[];
};

interface DungeonGame {
  dungeonFloor: number;
  width: number;
  height: number;
  walls: Position[];
  skeleton: Actor;
  goblin: Actor;
  player: Actor;
}

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value)
);

const cloneRecipe = handler<
  {},
  { state: DungeonGame; subtitle: string; prompt: string }
>((_, { prompt, state, subtitle }) => {
  let fieldsToInclude = Object.entries(state).reduce((acc, [key, value]) => {
    if (!key.startsWith("$") && !key.startsWith("_")) {
      acc[key] = value;
    }
    return acc;
  }, {} as any);

  return navigateTo(
    iframe({ data: fieldsToInclude, title: `Dungeon: ${subtitle}`, prompt })
  );
});

const generateNoise = (x: number, y: number, scale: number = 0.1): number => {
  const noise =
    Math.sin(x * scale) * Math.cos(y * scale) +
    Math.sin((x * scale) / 2 + (y * scale) / 2);
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

export const dungeon = recipe<DungeonGame>("Dungeon Game", (state) => {
  state.walls.setDefault(createNoiseGrid(10, 10));
  // state.player.setDefault({ x: 5, y: 5})
  state.width.setDefault(10);
  state.height.setDefault(10);
  state.player.setDefault({
    name: "Adventurer",
    position: { x: 5, y: 5 },
    hp: 100,
    xp: 0,
    inventory: ["sword", "shield", "crumpled felt hat"],
    dialogue: [
      "Hello, I am an adventurer.",
      "Oof, my knee!",
      "I need a potion.",
      "I am the best.",
    ],
  });
  state.dungeonFloor.setDefault(1);
  state.skeleton.setDefault({
    name: "Skeleton",
    position: { x: 7, y: 4 },
    hp: 10,
    xp: 10,
    inventory: ["bone", "skull"],
    dialogue: ["Rattle rattle.", "I am a skeleton.", "I am also the best."],
  });
  state.goblin.setDefault({
    name: "Goblin",
    position: { x: 5, y: 3 },
    hp: 20,
    xp: 20,
    inventory: ["club", "loincloth"],
    dialogue: ["Gobble gobble.", "I am a goblin.", "I am the worst."],
  });

  return {
    [NAME]: "Dungeon Adventure",
    [UI]: html`
      <div>
          <img width="100%" src="https://www.krea.ai/api/img?f=webp&i=https%3A%2F%2Ftest1-emgndhaqd0c9h2db.a01.azurefd.net%2Fimages%2F9fab7a72-1c5d-4d69-ad2d-e734cf3ec660.png"></img>
          <div style="border: 1px dashed red;">
          <common-input
            value=${state.player.name}
            placeholder="name"
            oncommon-input=${updateValue({ value: state.player.name })}
          ></common-input>
          </div>
          <h1>Welcome, ${state.player.name}!</h1>
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Character Status",
          prompt: "character status and top down map of the area",
        })}
          >Character Status</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Inventory",
          prompt: "inventory view",
        })}
            >Inventory</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Skeleton Status",
          prompt:
            "status from skeleton's perspective (selectable) with movement controls",
        })}
            >Skeleton Status</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Battle",
          prompt:
            "battle between player and skeleton with emoji battle graphics and loot",
        })}
            >Battle</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Chat",
          prompt:
            "retro rpg style dialogue box printing text character by character, you can switch which character you're talking to and cycle through the dialogue options. there should be a graphical representation of the character speaking.",
        })}
            >Chat</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Dragon Battle",
          prompt:
            "epic boss fight where the skeleton, hero and goblin must team up against a dragon - visualized as emoji, mother/earthbound style turn based battle with retro effects",
        })}
            >Dragon Battle</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "3D Viewer",
          prompt:
            "three.js dungeon viewer w/ procedural texture on walls. Add a minimap overlay to the 3D dungeon viewer, showing the player, skeleton and goblin's position. custom camera y axis rotation with slider control. nice lighting with torches.",
        })}
            >3D Viewer</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Map Editor",
          prompt: "grid-based map editor for walls",
        })}
            >Map Editor</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Dialogue Editor",
          prompt: "edit dialogue for any actor",
        })}
            >Dialogue Script Editor</common-button
        >
        <common-button onclick=${cloneRecipe({
          state,
          subtitle: "Campfire",
          prompt:
            "campfire scene with goblin, player and skeleton where they can rest, heal and have idle conversations (using their dialogue) - represent using emoji",
        })}
            >Campfire</common-button
        >
      </div>
    `,
  };
});
