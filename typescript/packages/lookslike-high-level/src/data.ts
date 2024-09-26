// This file is setting up example data

import { ID, TYPE, NAME, UI, Recipe } from "@commontools/common-builder";
import {
  run,
  cell,
  isCell,
  CellImpl,
  getCellReferenceOrValue,
} from "@commontools/common-runner";

import { todoList } from "./recipes/todo-list.js";
import { counter } from "./recipes/counter.js";

// Necessary, so that suggestions are indexed.
import "./recipes/todo-list-as-task.js";
import "./recipes/playlist.js";
import {
  getCellReferenceOrThrow,
  isCellProxyForDereferencing,
} from "@commontools/common-runner";

export type Charm = {
  [ID]: number;
  [NAME]?: string;
  [UI]?: any;
  [TYPE]?: string;
  [key: string]: any;
};

export { ID, TYPE, NAME, UI };

// TODO: TYPE is now obsolete. Do we still need this?
export function isCharm(value: any): value is Charm {
  return isCell(value) && ID in value.get() && TYPE in value.get();
}

export const charms = cell<CellImpl<Charm>[]>([]);

export function addCharms(newCharms: CellImpl<any>[]) {
  const currentCharms = charms.get();
  const currentIds = new Set(currentCharms.map((charm) => charm.get()[ID]));
  const charmsToAdd = newCharms.filter(
    (charm) => !currentIds.has(charm.get()[ID])
  );

  if (charmsToAdd.length > 0) {
    charms.send([...currentCharms, ...charmsToAdd]);
  }
}

const counterQuery = async function* () {
  const request = await fetch('///localhost:8080', {
    method: "PUT",
    body: JSON.stringify({
      select: {
        id: "?id",
        title: "?title",
        count: "?count",
      },
      where: [
        { Case: ["?id", "title", "?title"] },
        { Case: ["?id", "count", "?count"] },
      ]
    })
  })

  if (!request.body) {
    console.log('synTest request.body is null')
    return
  }

  const reader = request.body.getReader()
  const utf8 = new TextDecoder()
  while (true) {
    const read = await reader.read()
    if (read.done) {
      break
    } else {
      const [id, event, data] =
        utf8.decode(read.value).split('\n')

      yield {
        id: id.slice('id:'.length),
        event: event.slice('event:'.length),
        data: JSON.parse(data.slice('data:'.length))
      }
    }
  }
}

let syncedCharms: { [key: string]: CellImpl<any> } = {}

function postChange(id: string, prop: string, { newValue, oldValue }: { newValue: string | number, oldValue: string | number }) {
  fetch('///localhost:8080/', {
    method: 'PATCH',
    body: JSON.stringify([
      { Retract: [{ "/": id }, prop, oldValue] },
      { Assert: [{ "/": id }, prop, newValue] },
    ])
  })
}

let datas: { [key: string]: any } = {}

export async function watch() {
  let query = counterQuery()
  for await (const event of query) {
    console.log('synTest event', event)

    for (const change of event.data) {
      const synId = change.id["/"]

      // if we've not seen this counter before, create new charm
      if (!(synId in syncedCharms)) {

        let serverData = {
          title: change.title,
          count: { value: change.count },
        }
        let charm = run(counter, serverData)
        datas[synId] = serverData

        // hook up the cell to send changes to server
        charm.sink((instance) => {
          if (instance.title !== serverData.title) {
            let oldTitle = serverData.title
            let newTitle = instance.title
            serverData.title = newTitle
            postChange(synId, 'title', { newValue: newTitle, oldValue: oldTitle })
          }
        // no clue if we have to be this paranoid, but I've had too many infinite loops
        if (instance.count.value !== serverData.count.value) {
            let oldCount = serverData.count.value;
            let newCount = instance.count.value
            console.log(`counter sending count to server ${oldCount} -> ${newCount}`)
            serverData.count.value = newCount
            postChange(synId, 'count', { newValue: newCount, oldValue: oldCount })
          }
        })
        syncedCharms[synId] = charm
        openCharm(charm.get()[ID]);
      } else {
        // we've seen this counter before, update the existing instance

        let instance = syncedCharms[synId].getAsProxy()

        // no clue if we have to be this paranoid, but I've had too many infinite loops
        if (change.count !== instance.count.value) {
          console.log(`counter receiving count from server ${instance.count.value} -> ${change.count}`)
          instance.count.value = change.count
          datas[synId].count.value = change.count
        }
        if (change.title !== instance.title) {
          instance.title = change.title
          datas[synId].title = change.title
        }
      }
    }
  }
}

const synTest = async () => {
  watch();

  // while (true) {
  //   await sleep(1000)
  //   let syncIds = Object.keys(syncedCharms)
  //   let randomSyncId = syncIds[Math.floor(Math.random() * syncIds.length)];
  //   let oldValue = syncedCharms[randomSyncId].get().count
  //   const newValue = Math.floor(Math.random() * 100)
  //   console.log("synTest newValue", newValue, "oldValue", oldValue)

  //   // fixme(ja): maybe not an issue
  //   if (newValue !== oldValue) {
  //     await updateCounter({ "/": randomSyncId }, 'count', newValue, oldValue)
  //   }
  // }
}

synTest()

import { spawnCounter } from "./recipes/spawnCounter.js";

addCharms([
  run(spawnCounter, {}),
]);

export type RecipeManifest = {
  name: string;
  recipe: Recipe;
};

export const recipes: RecipeManifest[] = [
];

// Helper for mock data
function getFridayAndMondayDateStrings() {
  const today = new Date();
  const daysUntilFriday = (5 - today.getDay() + 7) % 7;

  const nextFriday = new Date(
    today.getTime() + daysUntilFriday * 24 * 60 * 60 * 1000
  );
  const followingMonday = new Date(
    nextFriday.getTime() + 3 * 24 * 60 * 60 * 1000
  );

  const formatDate = (date: Date): string => {
    return date.toISOString().split("T")[0];
  };

  return {
    startDate: formatDate(nextFriday),
    endDate: formatDate(followingMonday),
  };
}

// Terrible hack to open a charm from a recipe
let openCharmOpener: (charmId: number) => void = () => { };
export const openCharm = (charmId: number) => openCharmOpener(charmId);
openCharm.set = (opener: (charmId: number) => void) => {
  openCharmOpener = opener;
};

export function launch(recipe: Recipe, bindings: any) {
  if (isCellProxyForDereferencing(bindings)) {
    const { cell, path } = getCellReferenceOrThrow(bindings);
    const keys = Object.keys(bindings);
    bindings = Object.fromEntries(
      keys.map((key) => [key, { cell, path: [...path, key] }])
    );
  } else {
    bindings = Object.fromEntries(
      Object.entries(bindings).map(([key, value]) => [
        key,
        getCellReferenceOrValue(value),
      ])
    );
  }
  const charm = run(recipe, bindings);
  openCharm(charm.get()[ID]);
}

(window as any).recipes = recipes;
(window as any).charms = charms;
