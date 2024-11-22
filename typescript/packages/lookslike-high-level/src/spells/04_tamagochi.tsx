import { h, behavior, Reference, select } from "@commontools/common-system";
import { queryDefault } from "../sugar/query.js";
import { $, Instruction } from "synopsys";
import { event, Events } from "../sugar/event.js";
import { tags } from "../sugar/inbox.js";
import { set } from "../sugar/transact.js";
import { addTag } from "../sugar/tags.js";
import { defaultTo } from "../sugar/default.js";

export const source = { readingList: { v: 1 } };

function Footer({ }: {}) {
  return <div>
    <hr />
    <button onclick={events.onAdvanceTime}>Wait</button>
    <button onclick={events.onGiveFood}>Feed</button>
    <button onclick={events.onExercise}>Exercise</button>
    <button onclick={events.onBroadcast}>Broadcast</button>
  </div>
}

const genImage =
  (prompt: string) => `/api/img/?prompt=${encodeURIComponent(prompt)}`

function generateDescription({ time, hunger, size, color, description }: { time: number, hunger: number, size: number, color: string, description: string }) {
  const ageDesc = time < 5 ? 'very young' : time < 10 ? 'young' : time < 20 ? 'mature' : 'old';
  const hungerDesc = hunger < 2 ? 'satisfied' : hunger < 4 ? 'peckish' : hunger < 6 ? 'hungry' : 'starving';
  const sizeDesc = size < 3 ? 'tiny' : size < 6 ? 'medium-sized' : size < 10 ? 'large' : 'huge';

  return `Your ${color} ${sizeDesc} ${description} is ${ageDesc} and feeling ${hungerDesc}. ` +
    `They've been around for ${time} time units and have grown to size ${size}.`;
}

function EmptyState({ self, time, size, color, description, hunger }) {
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

// <Footer />

const Hunger = select({ self: $.self, hunger: $.hunger })
  .clause(defaultTo($.self, 'hunger', $.hunger, 0))

const Size = select({ self: $.self, size: $.size })
  .clause(defaultTo($.self, 'size', $.size, 1))

const Time = select({ self: $.self, time: $.time })
  .clause(defaultTo($.self, 'time', $.time, 0))

const Creature = select({ self: $.self, color: $.color, description: $.description })
  .clause(defaultTo($.self, 'description', $.description, 'lizard bunny'))
  .clause(defaultTo($.self, 'color', $.color, 'blue'))
  .with(Hunger)
  .with(Size)
  .with(Time)


const events: Events = {
  onAdvanceTime: '~/on/advanceTime',
  onGiveFood: '~/on/giveFood',
  onExercise: '~/on/exercise',
  onBroadcast: '~/on/broadcast',
}

export const tamagochi = behavior({
  view: Creature
    .render(EmptyState)
    .commit(),

  tickHunger: event(events.onAdvanceTime)
    .with(Hunger)
    .update(({ self, event, hunger }) => {
      return set(self, {
        hunger: hunger + 1
      })
    })
    .commit(),

  feed: event(events.onGiveFood)
    .with(Hunger)
    .with(Time)
    .update(({ self, event, hunger, time }) => {
      return set(self, {
        hunger: Math.max(0, hunger - 1),
        time: time + 1
      })
    })
    .commit(),

  exercise: event(events.onExercise)
    .with(Hunger)
    .with(Time)
    .with(Size)
    .update(({ self, event, hunger, time, size }) => {
      return set(self, {
        hunger: hunger + 1,
        time: time + 1,
        size: size + 1
      })
    })
    .commit(),

  onAddItem: event(events.onAdvanceTime)
    .with(Time)
    .update(({ self, event, time }) => {
      return set(self, {
        time: time + 1
      })
    })
    .commit(),

  broadcast: event(events.onBroadcast)
    .update(({ self }) => {
      return [
        addTag(self, '#tamagochi')
      ]
    })
    .commit(),
})

console.log(tamagochi)

export const spawn = (input: {} = source) => tamagochi.spawn(input);
