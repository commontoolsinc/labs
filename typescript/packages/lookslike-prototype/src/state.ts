import { computed, reactive } from "@vue/reactivity";
import { Message } from "./data.js";
import { Graph } from "./reactivity/runtime.js";
import { get, set, keys } from "idb-keyval";

import { Reflect } from "@rocicorp/reflect/client";
import { mutators } from "./reactivity/mutators.js";

export const r = new Reflect({
  server: "http://localhost:8081",
  roomID: "myRoom",
  userID: "myUser",
  mutators
});

export type Context<T> = {
  inputs: { [node: string]: { [input: string]: T } };
  outputs: { [node: string]: T };
  cancellation: (() => void)[];
};

export const session = reactive({
  history: [] as Message[],
  requests: [] as string[],
  reactCode: "",
  speclang: "",
  transformed: ""
});

export async function saveSession(name: IDBValidKey) {
  await set(name, JSON.parse(JSON.stringify(session)));
}

export async function loadSession(name: IDBValidKey) {
  const data = await get(name);
  if (data) {
    Object.assign(session, data);
  }
}

export async function listSessions() {
  return await keys();
}

export const sessionList = reactive({ recipes: [] as IDBValidKey[] });
listSessions().then((sessions) => {
  sessionList.recipes = sessions;
});

export const appState = reactive({} as any);
export const appGraph = new Graph(appState);

window.__refresh = () => {
  appGraph.update();
};

const syncChannel = new BroadcastChannel("sync");

type SyncMessage = { type: "write"; key: string; value: any };

export function gem(db: any, key: string) {
  return {
    get() {
      // if (db[key] === undefined) {
      //   db[key] = await get(key);
      // }

      return db[key];
    },
    set(value: any, broadcast = true) {
      console.log("gem:set", key, value);
      const plain = JSON.parse(JSON.stringify(value));
      db[key] = value;
      localStorage.setItem(key, JSON.stringify(plain));
      if (broadcast && JSON.stringify(value) !== "{}") {
        r.mutate.write({ key, data: plain });
        // syncChannel.postMessage({ type: "write", key, value: plain });
      }
    }
  };
}

syncChannel.onmessage = (e: MessageEvent<SyncMessage>) => {
  console.log("syncChannel", e.data);
  switch (e.data.type) {
    case "write":
      gem(appState, e.data.key).set(e.data.value, false);
      break;
  }
};
