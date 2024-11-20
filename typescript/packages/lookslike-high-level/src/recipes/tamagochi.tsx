import { h, behavior, Reference } from "@commontools/common-system";
import { queryDefault } from "../sugar/query.js";
import { Instruction } from "synopsys";

export const source = { readingList: { v: 1 } };

const createDispatch = <T extends string>(names: readonly T[]) => (name: T) => `~/on/${name}`;

// bf: probably not where we want to end up here but sort of works
// bf: there's something strange going on where new items look like clones of an existing item until you reload (I suspect local memory?)
const charms = (items: { id: Reference }[], behaviour: any) => items.sort((a, b) => a.id.toString().localeCompare(b.id.toString())).map(a => <common-charm
  id={a.id.toString()}
  key={a.id.toString()}
  spell={() => behaviour}
  entity={() => a.id}
></common-charm>);

function upsert(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Upsert: [self, k, v] } as Instruction));
}

function retract(self: Reference, fields: {}): Instruction[] {
  return Object.entries(fields).map(([k, v]) => ({ Retract: [self, k, v] } as Instruction));
}

// bf: exploring typesafe event names
const dispatch = createDispatch([
  'advance-time',
  'give-food',
  'exercise'
]);

const Creature = {
  color: 'blue',
  description: 'lizard bunny',
  hunger: 0,
  size: 1,
  time: 0,
};

function Footer({ }: {}) {
  return <div>
    <hr />
    <button onclick={dispatch('advance-time')}>Wait</button>
    <button onclick={dispatch('give-food')}>Feed</button>
    <button onclick={dispatch('exercise')}>Exercise</button>
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


function EmptyState({ self, time, size, color, description, hunger }: { self: Reference } & typeof Creature) {
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
    {Footer({})}
  </div>
}

export const tamagochi = behavior({
  view: queryDefault(Creature, 'time', 'hunger', 'size', 'color', 'description')
    .render(EmptyState)
    .commit(),

  tickHunger: queryDefault(Creature, 'hunger')
    .event('advance-time')
    .update(({ self, event, hunger }) => {
      return [
        ...upsert(self, {
          hunger: hunger + 1
        })
      ]
    })
    .commit(),

  feed: queryDefault(Creature, 'hunger', 'time')
    .event('give-food')
    .update(({ self, event, hunger, time }) => {
      return [
        ...upsert(self, {
          hunger: Math.max(0, hunger - 1),
          time: time + 1
        })
      ]
    })
    .commit(),

  exercise: queryDefault(Creature, 'hunger', 'time', 'size')
    .event('exercise')
    .update(({ self, event, hunger, time, size }) => {
      return [
        ...upsert(self, {
          hunger: hunger + 1,
          time: time + 1,
          size: size + 1
        })
      ]
    })
    .commit(),

  onAddItem: queryDefault(Creature, 'time')
    .event('advance-time')
    .update(({ self, event, time }) => {
      return [
        ...upsert(self, {
          time: time + 1
        })
      ]
    })
    .commit(),
})

console.log(tamagochi)

export const spawn = (input: {} = source) => tamagochi.spawn(input);
