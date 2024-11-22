import { h, behavior, Reference } from "@commontools/common-system";
import { event, events } from "../sugar/event.js";
import { set } from "../sugar/transact.js";
import { addTag } from "../sugar/tags.js";
import { field } from "../sugar/query.js";

const genImage =
  (prompt: string) => `/api/img/?prompt=${encodeURIComponent(prompt)}`

function generateDescription({ time, hunger, size, color, description }: { time: number, hunger: number, size: number, color: string, description: string }) {
  const ageDesc = time < 5 ? 'very young' : time < 10 ? 'young' : time < 20 ? 'mature' : 'old';
  const hungerDesc = hunger < 2 ? 'satisfied' : hunger < 4 ? 'peckish' : hunger < 6 ? 'hungry' : 'starving';
  const sizeDesc = size < 3 ? 'tiny' : size < 6 ? 'medium-sized' : size < 10 ? 'large' : 'huge';

  return `Your ${color} ${sizeDesc} ${description} is ${ageDesc} and feeling ${hungerDesc}. ` +
    `They've been around for ${time} time units and have grown to size ${size}.`;
}

function TamagochiView({ self, time, size, color, description, hunger }: { self: Reference, time: number, size: number, color: string, description: string, hunger: number }) {
  return <div title={'Tamagochi'} entity={self}>
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
    <img src={genImage(generateDescription({ time, size, color, description, hunger }))} />
    <p>
      {generateDescription({ time, size, color, description, hunger })}
    </p>
    {Footer({})}
  </div>
}

function Footer({ }: {}) {
  return <div>
    <hr />
    <button onclick={TamagochiEvents.onAdvanceTime}>Wait</button>
    <button onclick={TamagochiEvents.onGiveFood}>Feed</button>
    <button onclick={TamagochiEvents.onExercise}>Exercise</button>
    <button onclick={TamagochiEvents.onBroadcast}>Broadcast</button>
  </div>
}

// queries can be declared in piecemeal fashion and composed together later

const hunger = field('hunger', 0);
const size = field('size', 1)
const time = field('time', 0)
const description = field('description', 'lizard bunny')
const color = field('color', 'blue')

const Creature = description.with(hunger).with(size).with(time).with(color)

const TamagochiEvents = events({
  onAdvanceTime: '~/on/advanceTime',
  onGiveFood: '~/on/giveFood',
  onExercise: '~/on/exercise',
  onBroadcast: '~/on/broadcast',
})

export const tamagochi = behavior({
  view: Creature
    .render(TamagochiView)
    .commit(),

  // NOTE(ja): is there a way to only have this advance time - and
  // all the other events should only deal with non-time related changes?
  advanceTime: event(TamagochiEvents.onAdvanceTime)
    .with(time)
    .update(({ self, time }) => set(self, { time: time + 1 }))
    .commit(),

  tickHunger: event(TamagochiEvents.onAdvanceTime)
    .with(hunger)
    .update(({ self, hunger }) => set(self, { hunger: hunger + 1 }))
    .commit(),

  feed: event(TamagochiEvents.onGiveFood)
    .with(hunger)
    .with(time)
    .update(({ self, hunger, time }) => set(self, {
      hunger: Math.max(0, hunger - 1),
      time: time + 1
    }))
    .commit(),

  exercise: event(TamagochiEvents.onExercise)
    .with(hunger)
    .with(time)
    .with(size)
    .update(({ self, hunger, time, size }) => set(self, {
      hunger: hunger + 1,
      time: time + 1,
      size: size + 1
    }))
    .commit(),

  broadcast: event(TamagochiEvents.onBroadcast)
    .update(({ self }) => addTag(self, '#tamagochi'))
    .commit(),
})

console.log(tamagochi)

export const spawn = (source: {} = { tamagochi: 3 }) => tamagochi.spawn(source);
