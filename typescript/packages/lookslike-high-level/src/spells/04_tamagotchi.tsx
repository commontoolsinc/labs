import { h, behavior, Reference, select, $ } from "@commontools/common-system";
import { event, events, set, addTag, field, isEmpty } from "../sugar.js";
import { Description } from "./stickers/describe.jsx";
import { mixin } from "../sugar/mixin.js";

export const genImage = (prompt: string) =>
  `/api/img/?prompt=${encodeURIComponent(prompt)}`;

export function generateDescription({
  time,
  hunger,
  size,
  color,
  description,
}: {
  time: number;
  hunger: number;
  size: number;
  color: string;
  description: string;
}) {
  const ageDesc =
    time < 5
      ? "very young"
      : time < 10
        ? "young"
        : time < 20
          ? "mature"
          : "old";
  const hungerDesc =
    hunger < 2
      ? "satisfied"
      : hunger < 4
        ? "peckish"
        : hunger < 6
          ? "hungry"
          : "starving";
  const sizeDesc =
    size < 3
      ? "tiny"
      : size < 6
        ? "medium-sized"
        : size < 10
          ? "large"
          : "huge";

  return (
    `Your ${color} ${sizeDesc} ${description} is ${ageDesc} and feeling ${hungerDesc}. ` +
    `They've been around for ${time} time units and have grown to size ${size}.`
  );
}

function TamagotchiView({
  self,
  time,
  size,
  color,
  description,
  hunger,
}: {
  self: Reference;
  time: number;
  size: number;
  color: string;
  description: string;
  hunger: number;
}) {
  return (
    <div title={"Tamagotchi"} entity={self}>
      <div style={`color:${color}`}>{description}</div>
      <table>
        <tr>
          <th>Time</th>
          <th>Hunger</th>
          <th>Size</th>
        </tr>
        <tr>
          <td>{time}</td>
          <td>{hunger}</td>
          <td>{size}</td>
        </tr>
      </table>
      <img
        src={genImage(
          generateDescription({ time, size, color, description, hunger }),
        )}
      />
      <p>{generateDescription({ time, size, color, description, hunger })}</p>
      <Footer />
    </div>
  );
}

function Footer({ }: {}) {
  return (
    <div>
      <hr />
      <button onclick={TamagotchiEvents.onAdvanceTime}>Wait</button>
      <button onclick={TamagotchiEvents.onGiveFood}>Feed</button>
      <button onclick={TamagotchiEvents.onExercise}>Exercise</button>
      <button onclick={TamagotchiEvents.onBroadcast}>Broadcast</button>
    </div>
  );
}

// queries can be declared in piecemeal fashion and composed together later

export const hunger = field("hunger", 0);
export const size = field("size", 1);
export const time = field("time", 0);
export const description = field("description", "lizard bunny");
export const color = field("color", "blue");

export const Creature = description
  .with(hunger)
  .with(size)
  .with(time)
  .with(color);

const TamagotchiEvents = events({
  onAdvanceTime: "~/on/advanceTime",
  onGiveFood: "~/on/giveFood",
  onExercise: "~/on/exercise",
  onBroadcast: "~/on/broadcast",
});

export const tamagotchi = behavior({
  ...mixin(
    Description(
      ["hunger", "size", "time", "color", "description"],
      (self: any) =>
        `Come up with a cool description for this creature in one sentence: ${generateDescription(self)}`,
    ),
  ),

  emptyRule: select({ self: $.self })
    .clause(isEmpty($.self, 'hunger'))
    .clause(isEmpty($.self, 'size'))
    .clause(isEmpty($.self, 'time'))
    .update(({ self }) =>
      set(self, {
        hunger: 0,
        size: 1,
        time: 0,
        color: "blue",
        description: "lizard bunny",
      })
    )
    .commit(),

  view: Creature.render(TamagotchiView).commit(),

  // NOTE(ja): is there a way to only have this advance time - and
  // all the other events should only deal with non-time related changes?
  advanceTime: event(TamagotchiEvents.onAdvanceTime)
    .with(time)
    .update(({ self, time }) => set(self, { time: time + 1 }))
    .commit(),

  tickHunger: event(TamagotchiEvents.onAdvanceTime)
    .with(hunger)
    .update(({ self, hunger }) => set(self, { hunger: hunger + 1 }))
    .commit(),

  feed: event(TamagotchiEvents.onGiveFood)
    .with(hunger)
    .with(time)
    .update(({ self, hunger, time }) =>
      set(self, {
        hunger: Math.max(0, hunger - 1),
        time: time + 1,
      }),
    )
    .commit(),

  exercise: event(TamagotchiEvents.onExercise)
    .with(hunger)
    .with(time)
    .with(size)
    .update(({ self, hunger, time, size }) =>
      set(self, {
        hunger: hunger + 1,
        time: time + 1,
        size: size + 1,
      }),
    )
    .commit(),

  broadcast: event(TamagotchiEvents.onBroadcast)
    .update(({ self }) => addTag(self, "#tamagotchi"))
    .commit(),
});

console.log(tamagotchi);

export const spawn = (source: {} = { tamagotchi: 1 }) =>
  tamagotchi.spawn(source, "Tamagotchi");
