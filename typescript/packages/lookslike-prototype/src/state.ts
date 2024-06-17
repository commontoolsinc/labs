import { get, set, del, keys } from "idb-keyval";
import { SignalSubject } from "../../common-frp/lib/signal.js";

// Helper function for serialization boundary (this can be customized as needed)
const serializationBoundary = (data: any) => {
  return JSON.stringify(data);
};

export async function listKeys() {
  return await keys();
}

export type Context<T> = {
  inputs: { [node: string]: { [input: string]: T } };
  outputs: { [node: string]: T };
  cancellation: (() => void)[];
};

export function snapshot(ctx: Context<SignalSubject<any>>) {
  const snapshot: Context<any> = {
    inputs: {},
    outputs: {}
  };

  for (const key in ctx.outputs) {
    const value = ctx.outputs[key].get();
    snapshot.outputs[key] = value;
  }

  for (const key in ctx.inputs) {
    snapshot.inputs[key] = {};
    for (const inputKey in ctx.inputs[key]) {
      const value = ctx.inputs[key][inputKey].get();
      snapshot.inputs[key][inputKey] = value;
    }
  }

  return snapshot;
}

// System object that interacts with IndexedDB
export const storage = {
  get: async (key: string) => {
    const data = await get(key);
    if (data) {
      return data;
    }

    return [];
  },

  set: async (key: string, value: any) => {
    await set(key, value);
  },

  delete: async (key: string) => {
    await del(key);
  }
};
