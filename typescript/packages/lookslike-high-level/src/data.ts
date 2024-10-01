// This file is setting up example data

import { ID, TYPE, NAME, UI, Recipe, lift } from "@commontools/common-builder";
import {
  run,
  cell,
  isCell,
  CellImpl,
  getCellReferenceOrValue,
  addModuleByRef,
} from "@commontools/common-runner";

import { todoList } from "./recipes/todo-list.js";
import { localSearch } from "./recipes/local-search.js";
import { luftBnBSearch } from "./recipes/luft-bnb-search.js";
import { ticket } from "./recipes/ticket.js";
import { routine } from "./recipes/routine.js";
import { fetchExample } from "./recipes/fetchExample.js";
import { counter } from "./recipes/counter.js";
import { counters } from "./recipes/counters.js";

// Necessary, so that suggestions are indexed.
import "./recipes/todo-list-as-task.js";
import "./recipes/playlist.js";
import {
  getCellReferenceOrThrow,
  isCellProxyForDereferencing,
} from "@commontools/common-runner";
import { iframe } from "./recipes/iframe.js";
import { queryCollections } from "./recipes/queryCollections.js";
import { importCalendar } from "./recipes/importCalendar.js";
import { dungeon } from "./recipes/dungeon.js";
import { dataDesigner } from "./recipes/dataDesigner.js";
import { jsonImporter } from "./recipes/jsonImport.js";
import { prompt } from "./recipes/prompts.js";
import { wiki } from "./recipes/wiki.js";
import { helloIsolated } from "./recipes/helloIsolated.js";
import { coder } from "./recipes/coder.js";

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

addCharms([
  run(coder, {
    title: "hello world", src: `const greeting: string = "Hello, TypeScript!";
    console.log(greeting);
    
    // You can also use TypeScript-specific features
    interface Person {
      name: string;
      age: number;
    }
    
    const printPerson = (person: Person) => {
      console.log(person.name, 'is', person.age, 'years old');
    };
    
    printPerson({ name: "Alice", age: 30 });`})
  ]);

  setTimeout(() => {
    launch(coder, {
      title: "launcher", src: `import { html } from "@commontools/common-html";
import { recipe, UI, NAME } from "@commontools/common-builder";
import { launch } from "../data.js";

const helloWorld = recipe("hello", ({ name }) => (
  {
    [NAME]: "hello world",
    [UI]: html\`<h1>Hello, \$\{name}!</h1>\`
  }
));

console.log(helloWorld);

launch(helloWorld, { name: "world" });`}); }, 1000);


export type RecipeManifest = {
  name: string;
  recipeId: string;
};

// TODO: Make this a map of hashes that get persisted
export const recipeById = new Map<string, Recipe>();

let unknownCounter = 0;
function addRecipe(recipe: Recipe) {
  const id =
    (recipe.schema as { description: string })?.description ??
    `unknown-${unknownCounter++}`;

  recipeById.set(id, recipe);

  return id;
}

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

addModuleByRef(
  "navigateTo",
  lift<Charm>(({ [ID]: id }) => openCharm(id))
);

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

export let annotationsEnabled = cell<boolean>(false);
export const toggleAnnotations = () => {
  annotationsEnabled.send(!annotationsEnabled.get());
};
