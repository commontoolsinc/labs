import { h } from "@commontools/common-html";
import {
  recipe,
  NAME,
  UI,
  handler,
  lift,
  str,
} from "@commontools/common-builder";
import { z } from "zod";

const PositionSchema = z.object({
  x: z.number(),
  y: z.number(),
});

const ActorSchema = z.object({
  name: z.string(),
  position: PositionSchema,
  hp: z.number(),
  xp: z.number(),
  inventory: z.array(z.string()),
  dialogue: z.array(z.string()),
});

export const DungeonGameSchema = z.object({
  dungeonFloor: z.number().default(1),
  width: z.number().default(10),
  height: z.number().default(10),
  walls: z.array(PositionSchema).default([
    { x: 2, y: 3 },
    { x: 5, y: 7 },
    { x: 8, y: 4 },
    { x: 3, y: 8 },
    { x: 6, y: 2 },
    { x: 1, y: 6 },
    { x: 7, y: 5 },
    { x: 4, y: 1 },
    { x: 9, y: 9 },
    { x: 2, y: 7 },
  ]),
  player: ActorSchema.default({
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
  }),
  skeleton: ActorSchema.default({
    name: "Skeleton",
    position: { x: 7, y: 4 },
    hp: 10,
    xp: 10,
    inventory: ["bone", "skull"],
    dialogue: ["Rattle rattle.", "I am a skeleton.", "I am also the best."],
  }),
  goblin: ActorSchema.default({
    name: "Goblin",
    position: { x: 5, y: 3 },
    hp: 20,
    xp: 20,
    inventory: ["club", "loincloth"],
    dialogue: ["Gobble gobble.", "I am a goblin.", "I am the worst."],
  }),
});

export type DungeonGame = z.infer<typeof DungeonGameSchema>;

const updateValue = handler<{ detail: { value: string } }, { value: string }>(
  ({ detail }, state) => detail?.value && (state.value = detail.value),
);

const count = lift(({ items }: { items: [] }) => items?.length || 0);

export default recipe(DungeonGameSchema, (state) => {
  const walls = count({ items: state.walls });

  return {
    [NAME]: "Dungeon Explorer",
    [UI]: (
      <div>
        <img
          width="256px"
          src={str`/api/img?prompt=Dungeon+Game+player+${state.player.name}`}
        />
        <div style="border: 1px dashed red;">
          <common-input
            value={state.player.name}
            placeholder="name"
            oncommon-input={updateValue({ value: state.player.name })}
          ></common-input>
        </div>
        <h1>Welcome, {state.player.name}!</h1>
        <p>There are {walls} walls</p>
      </div>
    ),
  };
});
