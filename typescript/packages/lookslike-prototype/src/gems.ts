import { createRxDatabase, addRxPlugin } from "rxdb";
import { getRxStorageMemory } from "rxdb/plugins/storage-memory";
import { RxDBDevModePlugin } from "rxdb/plugins/dev-mode";
import { html } from "lit-html";
import { RxDBStatePlugin } from "rxdb/plugins/state";
import { Observable, Subscription } from "rxjs";
import { LitElement, css } from "lit-element";
import { customElement, property, state } from "lit-element/decorators.js";

addRxPlugin(RxDBStatePlugin);
addRxPlugin(RxDBDevModePlugin);

// Create the database
async function createDatabase() {
  const db = await createRxDatabase({
    name: "inventorydb",
    storage: getRxStorageMemory()
  });

  return db;
}

const db = await createDatabase();
export const graphState = await db.addState();

setTimeout(async () => {
  await graphState.set("state", (_) => ({}));
}, 100);

setTimeout(async () => {
  document.body.appendChild(document.createElement("inventory-view"));
}, 1000);

export function gem<T>(path: string): Gem<T> {
  const p = "state." + path;
  const f: Observable<T> = graphState.get$(p);
  return {
    path: p,
    data: f
  };
}

export async function read<T>(gem: Gem<T>) {
  try {
    return await graphState.get(gem.path);
  } catch (e) {
    console.warn(e);
    return null;
  }
}

export async function write<T>(gem: Gem<T>, value: T) {
  try {
    await graphState.set(gem.path, (_) => value);
    await sleep(100);
  } catch (e) {
    console.warn(e);
  }
}

export async function update<T>(gem: Gem<T>, fn: (value: T) => T) {
  try {
    await graphState.set(gem.path, fn);
    await sleep(100);
  } catch (e) {
    console.warn(e);
  }
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type Gem<T> = {
  path: string;
  data: Observable<T>;
};
